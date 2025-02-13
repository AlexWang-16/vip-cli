import { exec } from 'shelljs';
import path from 'path';
import xdgBasedir from 'xdg-basedir';
import os from 'os';
import checkDiskSpace from 'check-disk-space';
import { Confirm } from 'enquirer';
import { Job } from '../../graphqlTypes';
import { formatMetricBytes } from '../cli/format';
import { DockerMachineNotFoundError } from './docker-machine-not-found-error';

const oneGiBInBytes = 1024 * 1024 * 1024;

export class BackupStorageAvailability {
	archiveSize: number;

	constructor( archiveSize: number ) {
		this.archiveSize = archiveSize;
	}

	static createFromDbCopyJob( job: Job ): BackupStorageAvailability {
		const bytesWrittenMeta = job.metadata?.find( meta => meta?.name === 'bytesWritten' );
		if ( ! bytesWrittenMeta?.value ) {
			throw new Error( 'Meta not found' );
		}

		return new BackupStorageAvailability( Number( bytesWrittenMeta.value ) );
	}

	getDockerStorageKiBRaw(): string | undefined {
		return exec( `docker run --rm alpine df -k`, { silent: true } )
			.grep( /\/dev\/vda1/ )
			.head( { '-n': 1 } )
			.replace( /\s+/g, ' ' )
			.split( ' ' )[ 3 ];
	}

	getDockerStorageAvailable(): number {
		const kiBLeft = this.getDockerStorageKiBRaw();

		if ( ! kiBLeft || Number.isNaN( Number( kiBLeft ) ) ) {
			throw new DockerMachineNotFoundError();
		}

		return Number( kiBLeft ) * 1024;
	}

	bytesToHuman( bytes: number ) {
		return formatMetricBytes( bytes );
	}

	async getStorageAvailableInVipPath() {
		const vipDir = path.join( xdgBasedir.data ?? os.tmpdir(), 'vip' );

		const diskSpace = await checkDiskSpace( vipDir );
		return diskSpace.free;
	}

	getReserveSpace(): number {
		return oneGiBInBytes;
	}

	getSqlSize(): number {
		// We estimated that it'd be about 3.5x the archive size.
		return this.archiveSize * 3.5;
	}

	getArchiveSize(): number {
		return this.archiveSize;
	}

	getStorageRequiredInMainMachine(): number {
		return this.getArchiveSize() + this.getSqlSize() + this.getReserveSpace();
	}

	getStorageRequiredInDockerMachine(): number {
		return this.getSqlSize() + this.getReserveSpace();
	}

	async isStorageAvailableInMainMachine(): Promise< boolean > {
		return ( await this.getStorageAvailableInVipPath() ) > this.getStorageRequiredInMainMachine();
	}

	isStorageAvailableInDockerMachine(): boolean {
		return this.getDockerStorageAvailable() > this.getStorageRequiredInDockerMachine();
	}

	// eslint-disable-next-line id-length
	async validateAndPromptDiskSpaceWarningForBackupImport(): Promise< boolean > {
		const isStorageAvailable =
			( await this.getStorageAvailableInVipPath() ) > this.getArchiveSize();
		if ( ! isStorageAvailable ) {
			const storageRequired = this.getArchiveSize();
			const confirmPrompt = new Confirm( {
				message: `We recommend that you have at least ${ this.bytesToHuman(
					storageRequired
				) } of free space in your machine to download this database backup. Do you still want to continue with downloading the database backup?`,
			} );

			return await confirmPrompt.run();
		}

		return true;
	}

	// eslint-disable-next-line id-length
	async validateAndPromptDiskSpaceWarningForDevEnvBackupImport(): Promise< boolean > {
		let storageAvailableInMainMachinePrompted = false;

		if ( ! ( await this.isStorageAvailableInMainMachine() ) ) {
			const storageRequired = this.getStorageRequiredInMainMachine();
			const storageAvailableInVipPath = this.bytesToHuman(
				await this.getStorageAvailableInVipPath()
			);

			const confirmPrompt = new Confirm( {
				message: `We recommend that you have at least ${ this.bytesToHuman(
					storageRequired
				) } of free space in your machine to import this database backup. We estimate that you currently have ${ storageAvailableInVipPath } of space in your machine.
Do you still want to continue with importing the database backup?
`,
			} );

			storageAvailableInMainMachinePrompted = await confirmPrompt.run();

			if ( ! storageAvailableInMainMachinePrompted ) {
				return false;
			}
		}

		try {
			if ( ! this.isStorageAvailableInDockerMachine() ) {
				const storageRequired = this.getStorageRequiredInDockerMachine();
				const storageAvailableInDockerMachine = this.bytesToHuman(
					this.getDockerStorageAvailable()
				);
				const confirmPrompt = new Confirm( {
					message: `We recommend that you have at least ${ this.bytesToHuman(
						storageRequired
					) } of free space in your Docker machine to import this database backup. We estimate that you currently have ${ storageAvailableInDockerMachine } of space in your machine.
Do you still want to continue with importing the database backup?`,
				} );

				return await confirmPrompt.run();
			}
		} catch ( error ) {
			if ( error instanceof DockerMachineNotFoundError ) {
				// skip storage available check
				return true;
			}

			throw error;
		}

		return true;
	}
}
