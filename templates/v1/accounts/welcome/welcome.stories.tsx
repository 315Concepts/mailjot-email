import { faker } from "@faker-js/faker";
import { templateStories } from "../../../../storybook/templateStories.js";
import * as template from "./index.js";

const stories = templateStories(template, {
  random: () => ({ name: faker.person.firstName() }),
});

export default { ...stories.meta };
export const Preview = stories.Preview;
