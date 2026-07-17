import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ImageUploader } from "./ImageUploader";
import { usePoseStore } from "../../store/usePoseStore";

describe("ImageUploader", () => {
  beforeEach(() => {
    usePoseStore.getState().reset();
  });

  it("renders the upload UI", () => {
    render(<ImageUploader />);
    expect(
      screen.getByText("クリックまたはドラッグ＆ドロップで画像をアップロード")
    ).toBeInTheDocument();
    expect(screen.getByText("対応フォーマット: JPG, PNG, 最大 10MB")).toBeInTheDocument();
  });

  it("handles click to open file dialog", () => {
    render(<ImageUploader />);
    const container = screen
      .getByText("クリックまたはドラッグ＆ドロップで画像をアップロード")
      .closest("div")?.parentElement?.parentElement;
    const input = container?.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");

    if (container) {
      fireEvent.click(container);
      expect(clickSpy).toHaveBeenCalled();
    }
  });

  it("validates file type on change", async () => {
    render(<ImageUploader />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });

    fireEvent.change(input, { target: { files: [file] } });

    expect(usePoseStore.getState().isError).toBe(true);
    expect(usePoseStore.getState().errorMessage).toBe(
      "JPEG または PNG 形式の画像をアップロードしてください。"
    );
  });

  it("validates file size on change", async () => {
    render(<ImageUploader />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["a".repeat(10 * 1024 * 1024 + 1)], "large.jpg", {
      type: "image/jpeg",
    });

    fireEvent.change(input, { target: { files: [file] } });

    expect(usePoseStore.getState().isError).toBe(true);
    expect(usePoseStore.getState().errorMessage).toBe(
      "画像サイズは 10MB 以下にしてください。"
    );
  });

  it("reads valid image file correctly on change", async () => {
    const user = userEvent.setup();
    render(<ImageUploader />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["mock-image-content"], "test.png", { type: "image/png" });

    await user.upload(input, file);

    await waitFor(() => {
      expect(usePoseStore.getState().imageSrc).toContain("data:image/png;base64,");
    });
  });

  it("handles drag events correctly", () => {
    render(<ImageUploader />);
    const container = screen
      .getByText("クリックまたはドラッグ＆ドロップで画像をアップロード")
      .closest("div")?.parentElement?.parentElement;

    if (container) {
      fireEvent.dragOver(container);
      expect(container.className).toContain("border-blue-500");

      fireEvent.dragLeave(container);
      expect(container.className).not.toContain("border-blue-500");
    }
  });

  it("handles drop event with invalid file", () => {
    render(<ImageUploader />);
    const container = screen
      .getByText("クリックまたはドラッグ＆ドロップで画像をアップロード")
      .closest("div")?.parentElement?.parentElement;

    if (container) {
      const file = new File(["hello"], "hello.pdf", { type: "application/pdf" });
      fireEvent.drop(container, {
        dataTransfer: {
          files: [file],
        },
      });

      expect(usePoseStore.getState().isError).toBe(true);
      expect(usePoseStore.getState().errorMessage).toBe(
        "JPEG または PNG 形式の画像をアップロードしてください。"
      );
    }
  });

  it("handles drop event with valid file", async () => {
    render(<ImageUploader />);
    const container = screen
      .getByText("クリックまたはドラッグ＆ドロップで画像をアップロード")
      .closest("div")?.parentElement?.parentElement;

    if (container) {
      const file = new File(["image-content"], "test.jpg", { type: "image/jpeg" });
      fireEvent.drop(container, {
        dataTransfer: {
          files: [file],
        },
      });

      await waitFor(() => {
        expect(usePoseStore.getState().imageSrc).toContain("data:image/jpeg;base64,");
      });
    }
  });
});
