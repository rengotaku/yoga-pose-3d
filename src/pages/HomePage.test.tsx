import { render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { describe, it, expect } from "vitest";
import { HomePage } from "./HomePage";

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
