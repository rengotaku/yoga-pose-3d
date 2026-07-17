import { render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { describe, it, expect } from "vitest";
import { HomePage } from "./HomePage";

vi.mock("../components/PoseViewer3D", () => ({
  PoseViewer3D: () => <div data-testid="mock-pose-viewer-3d">3D Viewer Mock</div>,
}));

describe("HomePage", () => {
  it("renders the title", () => {
    render(
      <BrowserRouter>
        <HomePage />
      </BrowserRouter>
    );

    expect(screen.getByText("ヨガポーズ推定")).toBeInTheDocument();
  });
});
