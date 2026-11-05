import { templateStories } from "../../../../storybook/templateStories.js";
import * as template from "./index.js";

const stories = templateStories(template);

export default { ...stories.meta };
export const Preview = stories.Preview;
