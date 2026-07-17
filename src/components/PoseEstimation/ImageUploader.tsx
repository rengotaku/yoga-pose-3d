import React, { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { usePoseStore } from "../../store/usePoseStore";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export const ImageUploader: React.FC = () => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setImageSrc = usePoseStore((s) => s.setImageSrc);
  const reset = usePoseStore((s) => s.reset);
  const setError = usePoseStore((s) => s.setError);

  const handleFile = (file: File) => {
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      reset();
      setError("JPEG または PNG 形式の画像をアップロードしてください。");
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      reset();
      setError("画像サイズは 10MB 以下にしてください。");
      return;
    }

    reset();

    const reader = new FileReader();
    reader.onload = (e) => {
      const src = e.target?.result;
      if (typeof src === "string") {
        setImageSrc(src);
      }
    };
    reader.onerror = () => {
      setError("画像の読み込みに失敗しました。");
    };
    reader.readAsDataURL(file);
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  };

  return (
    <div
      className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
        isDragging
          ? "border-blue-500 bg-blue-50"
          : "border-gray-300 hover:border-blue-400"
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => fileInputRef.current?.click()}
    >
      <input
        type="file"
        ref={fileInputRef}
        onChange={onChange}
        accept="image/jpeg, image/png"
        className="hidden"
      />
      <div className="flex flex-col items-center justify-center space-y-4 text-gray-500">
        <Upload className="w-12 h-12 text-gray-400" />
        <div>
          <p className="font-semibold text-gray-700">
            クリックまたはドラッグ＆ドロップで画像をアップロード
          </p>
          <p className="text-sm mt-1">対応フォーマット: JPG, PNG, 最大 10MB</p>
        </div>
      </div>
    </div>
  );
};
