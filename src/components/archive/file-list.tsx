"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { File, FolderOpen, Archive } from "lucide-react";

interface FileEntry {
  name: string;
  type: "file" | "dir";
  path: string;
}

export function FileList({
  files,
  directory,
}: {
  files: FileEntry[];
  directory: string;
}) {
  const t = useTranslations("archive");
  if (files.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-8 text-center">
        <Archive className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
        <h3 className="font-medium mb-1">{t("emptyTitle")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("emptyDesc")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {files.map((file) => (
        <FileRow key={file.path} file={file} />
      ))}
    </div>
  );
}

function FileRow({ file }: { file: FileEntry }) {
  const t = useTranslations("archive");
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button
        onClick={() => file.type === "file" && setExpanded(!expanded)}
        className="w-full flex items-center gap-3 rounded-md px-4 py-2 text-sm hover:bg-accent transition-colors text-left"
      >
        {file.type === "dir" ? (
          <FolderOpen className="h-4 w-4 text-brand-600 dark:text-brand-400 shrink-0" />
        ) : (
          <File className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
        <span className="flex-1 truncate">{file.name}</span>
        <span className="text-xs text-muted-foreground uppercase">{file.type}</span>
      </button>
      {expanded && (
        <div className="ml-8 mr-4 my-2 rounded-md bg-muted/50 p-3 text-xs font-mono text-muted-foreground">
          {t("placeholderPreview")}
        </div>
      )}
    </div>
  );
}
