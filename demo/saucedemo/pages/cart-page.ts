import { expect, type Locator, type Page } from '@playwright/test';

export class CartPage {
  readonly page: Page;
  readonly itemNames: Locator;
  readonly checkoutButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.itemNames = page.getByTestId('inventory-item-name');
    this.checkoutButton = page.getByTestId('checkout');
  }

  async goto() {
    await this.page.goto('/cart.html');
  }

  // The inventory page shares the inventory-item-name test id, so anything that
  // reads or acts on the cart calls this first. Checkout exists only on the cart.
  async waitForLoaded() {
    await expect(this.checkoutButton).toBeVisible();
  }

  // E2E proof: a harmless comment so the diff touches a Page Object that specs import.
  async checkout() {
    await this.waitForLoaded();
    await this.checkoutButton.click();
  }
}
