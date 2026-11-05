import { faker } from "@faker-js/faker";
import { templateStories } from "../../../../storybook/templateStories.js";
import * as template from "./index.js";

const stories = templateStories(template, {
  random: () => ({
    customerName: faker.person.firstName(),
    orderNumber: `ORD-${faker.string.numeric(4)}`,
    currency: faker.helpers.arrayElement(["USD", "EUR", "GBP"] as const),
    charges: Array.from({ length: faker.number.int({ min: 1, max: 5 }) }, () => ({
      description: faker.commerce.productName(),
      quantity: faker.number.int({ min: 1, max: 4 }),
      unitPriceCents: faker.number.int({ min: 100, max: 20000 }),
    })),
  }),
});

export default { ...stories.meta };
export const Preview = stories.Preview;
