"use client";

import { useState, useCallback, type DragEvent, type ClipboardEvent } from "react";

const MAX_SIZE = 10 * 1024 * 1024; // 10MB
/**
 * Longest-side cap before upload. Vision APIs bill images by dimensions
 * (DeepSeek converts pixels to input tokens), so a 24MP phone photo costs the
 * same as a page of text many times over — 1568px keeps detail the model can
 * actually use while bounding token spend.
 */
const MAX_DIMENSION = 1568;
const JPEG_QUALITY = 0.85;

/**
 * Downscale + re-encode an image for upload. Falls back to the original file
 * when canvas processing is unavailable (SVG, exotic formats, decode failure).
 * Never returns a LARGER file than the original.
 */
async function compressImage(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
    // Already small enough AND already a web-efficient format — send as-is.
    if (scale >= 1 && (file.type === "image/jpeg" || file.type === "image/webp")) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", {
      type: "image/jpeg",
    });
  } catch {
    return file;
  }
}

export function useImageAttachments() {
  const [images, setImages] = useState<File[]>([]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const valid = Array.from(files).filter((f) => {
      if (f.size > MAX_SIZE) return false;
      return f.type.startsWith("image/");
    });
    if (valid.length === 0) return;
    void Promise.all(valid.map(compressImage)).then((compressed) =>
      setImages((prev) => [...prev, ...compressed]),
    );
  }, []);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearImages = useCallback(() => setImages([]), []);

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.files;
      if (items?.length) addFiles(items);
    },
    [addFiles]
  );

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
  }, []);

  return { images, addFiles, removeImage, clearImages, handlePaste, handleDrop, handleDragOver };
}
