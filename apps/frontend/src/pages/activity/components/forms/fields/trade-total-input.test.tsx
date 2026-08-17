import { render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@wealthfolio/ui";
import userEvent from "@testing-library/user-event";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { TradeTotalInput } from "./trade-total-input";

interface HarnessProps {
  calculatedAmount: number;
  initialAmount?: number;
}

function Harness({ calculatedAmount, initialAmount }: HarnessProps) {
  const form = useForm({ defaultValues: { amount: initialAmount } });

  return (
    <TooltipProvider>
      <FormProvider {...form}>
        <TradeTotalInput
          side="buy"
          calculatedAmount={calculatedAmount}
          initialAmount={initialAmount}
          currency="USD"
        />
      </FormProvider>
    </TooltipProvider>
  );
}

describe("TradeTotalInput", () => {
  it("initializes and updates a new trade from its calculated total", async () => {
    const { rerender } = render(<Harness calculatedAmount={100.124} />);

    await waitFor(() => expect(screen.getByTestId("amount-input")).toHaveValue("100.124"));
    expect(screen.getByText("Calculated")).toBeInTheDocument();

    rerender(<Harness calculatedAmount={125.456} />);

    await waitFor(() => expect(screen.getByTestId("amount-input")).toHaveValue("125.456"));
  });

  it("preserves a supplied total until the user chooses the calculation", async () => {
    const user = userEvent.setup();
    render(<Harness calculatedAmount={0.5898108} initialAmount={0.3} />);

    expect(screen.getByTestId("amount-input")).toHaveValue("0.3");
    expect(screen.getByText("Custom")).toBeInTheDocument();
    expect(screen.getByText("Calculated from trade details: $0.59")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Use calculated" }));

    await waitFor(() => expect(screen.getByTestId("amount-input")).toHaveValue("0.5898108"));
    expect(screen.getByText("Calculated")).toBeInTheDocument();
  });

  it("returns a cleared supplied total to calculated mode", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness calculatedAmount={100} initialAmount={90} />);
    const input = screen.getByTestId("amount-input");

    await user.clear(input);
    expect(input).toHaveValue("");
    await user.tab();

    await waitFor(() => expect(input).toHaveValue("100"));
    expect(screen.getByText("Calculated")).toBeInTheDocument();

    rerender(<Harness calculatedAmount={120} initialAmount={90} />);
    await waitFor(() => expect(input).toHaveValue("120"));
  });

  it("stops recalculating after the user edits the total", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness calculatedAmount={100} />);
    const input = screen.getByTestId("amount-input");

    await waitFor(() => expect(input).toHaveValue("100"));
    await user.clear(input);
    await waitFor(() => expect(input).toHaveValue(""));
    await user.type(input, "90");
    expect(screen.getByText("Custom")).toBeInTheDocument();

    rerender(<Harness calculatedAmount={120} />);

    expect(input).toHaveValue("90");
  });
});
