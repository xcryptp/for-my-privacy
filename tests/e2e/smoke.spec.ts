import { test, expect } from './fixtures';

test('the extension loads', async ({ extensionId, sw }) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  expect(sw.url()).toBe(`chrome-extension://${extensionId}/background.js`);
});
