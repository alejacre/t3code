import {
  archiveDroppedDirectory,
  type DroppedDirectoryEntry,
  partitionDroppedItems,
} from "./droppedDirectoryArchive";

export interface WorkspaceFileDragEvent {
  readonly dataTransfer: {
    readonly types: ReadonlyArray<string>;
    readonly files: Iterable<File>;
    /** Present on real drops; carries the directory entries a folder drop needs. */
    readonly items?: ArrayLike<DataTransferItem> | null | undefined;
    dropEffect: string;
  };
  readonly relatedTarget: EventTarget | null;
  readonly currentTarget: {
    contains(target: Node | null): boolean;
  };
  preventDefault(): void;
}

export interface WorkspaceFileDropHost {
  setDragActive(active: boolean): void;
  addFiles(files: File[]): void;
  /** Called once per dropped folder that was packed into an archive attachment. */
  onDirectoryArchived?(input: {
    readonly directoryName: string;
    readonly archive: File;
    readonly fileCount: number;
  }): void;
  /** Called once per dropped folder that could not be archived. */
  onDirectoryError?(message: string): void;
}

/** Injectable for tests; production uses the jszip-backed archiver. */
export type DroppedDirectoryArchiver = typeof archiveDroppedDirectory;

function isFileDrag(event: WorkspaceFileDragEvent): boolean {
  return event.dataTransfer.types.includes("Files");
}

function movedWithinDropTarget(event: WorkspaceFileDragEvent): boolean {
  return event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget as Node);
}

async function archiveDroppedDirectories(
  host: WorkspaceFileDropHost,
  directories: ReadonlyArray<DroppedDirectoryEntry>,
  archiver: DroppedDirectoryArchiver,
): Promise<void> {
  // Folders arrive after plain files so the composer sees the cheap items
  // first; archiving can take a moment for large trees.
  for (const directory of directories) {
    try {
      const { archive, fileCount } = await archiver(directory);
      host.addFiles([archive]);
      host.onDirectoryArchived?.({ directoryName: directory.name, archive, fileCount });
    } catch (error) {
      host.onDirectoryError?.(
        error instanceof Error && error.message !== ""
          ? error.message
          : `Folder '${directory.name}' could not be attached.`,
      );
    }
  }
}

export function makeWorkspaceFileDropHandlers(
  host: WorkspaceFileDropHost,
  options?: { readonly archiveDirectory?: DroppedDirectoryArchiver },
) {
  const archiver = options?.archiveDirectory ?? archiveDroppedDirectory;
  return {
    onDragEnter(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(true);
    },
    onDragOver(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      host.setDragActive(true);
    },
    onDragLeave(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(false);
    },
    onDrop(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      host.setDragActive(false);
      const { files, directories } = partitionDroppedItems({
        items: event.dataTransfer.items,
        files: event.dataTransfer.files,
      });
      if (files.length > 0 || directories.length === 0) {
        host.addFiles(files);
      }
      if (directories.length > 0) {
        void archiveDroppedDirectories(host, directories, archiver);
      }
    },
  };
}
