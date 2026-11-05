import { Body, Container, Html, Section, Text } from "react-email";
import { schema, type Input } from "./schema.js";

export { schema };

export const metadata = {
  id: "billing/receipt",
  version: "1.0.0",
  description: "Receipt for a completed order, with an itemised charge table and total.",
};

export const subject = (input: Input) => `Your receipt for order ${input.orderNumber}`;

export const examples: Record<string, Input> = {
  default: {
    customerName: "Alice",
    orderNumber: "ORD-1001",
    currency: "USD",
    charges: [
      { description: "Pro plan (monthly)", quantity: 1, unitPriceCents: 1900 },
      { description: "Extra seat", quantity: 3, unitPriceCents: 500 },
    ],
  },
  single: {
    customerName: "Bob",
    orderNumber: "ORD-2002",
    currency: "EUR",
    charges: [{ description: "One-off setup", quantity: 1, unitPriceCents: 4900 }],
  },
};

const cell = { padding: "6px 8px", borderBottom: "1px solid #ddd", textAlign: "left" } as const;
const numeric = { ...cell, textAlign: "right" } as const;

export default function Receipt({ customerName, orderNumber, currency, charges }: Input) {
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency });
  const format = (cents: number) => money.format(cents / 100);
  const totalCents = charges.reduce((sum, c) => sum + c.quantity * c.unitPriceCents, 0);

  return (
    <Html>
      <Body style={{ fontFamily: "Helvetica, Arial, sans-serif" }}>
        <Container>
          <Text>{`Hi ${customerName}, thank you for your purchase. Here is your receipt.`}</Text>
          <Text>{`Order number: ${orderNumber}`}</Text>
          <Section>
            <table data-text-format="dataTable" width="100%" cellPadding={0} cellSpacing={0} style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={cell}>Description</th>
                  <th style={numeric}>Qty</th>
                  <th style={numeric}>Unit price</th>
                  <th style={numeric}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {charges.map((c, i) => (
                  <tr key={i}>
                    <td style={cell}>{c.description}</td>
                    <td style={numeric}>{String(c.quantity)}</td>
                    <td style={numeric}>{format(c.unitPriceCents)}</td>
                    <td style={numeric}>{format(c.quantity * c.unitPriceCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <Text>
            <strong>{`Total: ${format(totalCents)}`}</strong>
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
