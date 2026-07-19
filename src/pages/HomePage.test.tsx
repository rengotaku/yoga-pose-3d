import { render, screen, fireEvent, act } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { HomePage } from "./HomePage";
import { usePoseStore } from "../store/usePoseStore";

vi.mock("../components/PoseViewer3D", () => ({
  PoseViewer3D: () => <div data-testid="mock-pose-viewer-3d">3D Viewer Mock</div>,
}));

const renderHomePage = () =>
  render(
    <BrowserRouter>
      <HomePage />
    </BrowserRouter>
  );

describe("HomePage", () => {
  beforeEach(() => {
    usePoseStore.getState().reset();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("renders the title", () => {
    renderHomePage();

    expect(screen.getByText("ヨガポーズ推定")).toBeInTheDocument();
  });

  it("collapses the 3D viewer section by default (#59)", () => {
    renderHomePage();

    expect(screen.getByText("2. 3Dマネキン (360度ビュー)")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-pose-viewer-3d")).not.toBeInTheDocument();
  });

  it("toggles the 3D viewer section via the header button (#59)", () => {
    renderHomePage();

    const toggle = screen.getByRole("button", {
      name: /2\. 3Dマネキン/,
    });
    fireEvent.click(toggle);
    expect(screen.getByTestId("mock-pose-viewer-3d")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByTestId("mock-pose-viewer-3d")).not.toBeInTheDocument();
  });

  it("auto-expands and scrolls to the section when a pose result arrives (#59)", () => {
    vi.useFakeTimers();
    try {
      renderHomePage();
      expect(screen.queryByTestId("mock-pose-viewer-3d")).not.toBeInTheDocument();

      act(() => {
        usePoseStore
          .getState()
          .setPoseResult(
            [{ x: 0, y: 0, z: 0, visibility: 1 }],
            [{ x: 0, y: 0, z: 0, visibility: 1 }],
            { width: 100, height: 100 }
          );
      });

      expect(screen.getByTestId("mock-pose-viewer-3d")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "center",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
