import { injectable } from '@theia/core/shared/inversify';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { Stat, WriteFileOptions } from '@theia/filesystem/lib/common/files';

import { remoteModifiedSince } from './qe-ssh-file-system-provider';

/**
 * Theia's file service, with a strict "modified since" for remote files (`remoteModifiedSince` says why): a save over
 * a change made on the server asks first ("has been changed on the file system") even when both fall in one second.
 * Every other file keeps Theia's check.
 */
@injectable()
export class QeFileService extends FileService {
  protected override modifiedSince(stat: Stat, options?: WriteFileOptions): boolean {
    return remoteModifiedSince(stat, options) ?? super.modifiedSince(stat, options);
  }
}
