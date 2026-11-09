import { expect, type Locator, type Page } from '@playwright/test';
import { PASSWORD } from '../fixtures/users';

// E2E proof, second push: a harmless comment so the sticky comment must be updated in place.
export class LoginPage {
  readonly page: Page;
  readonly username: Locator;
  readonly password: Locator;
  readonly loginButton: Locator;
  readonly error: Locator;

  constructor(page: Page) {
    this.page = page;
    this.username = page.getByTestId('username');
    this.password = page.getByTestId('password');
    this.loginButton = page.getByTestId('login-button');
    this.error = page.getByTestId('error');
  }

  async goto() {
    await this.page.goto('/');
  }

  async login(user: string, password: string = PASSWORD) {
    await this.username.fill(user);
    await this.password.fill(password);
    await this.loginButton.click();
  }

  async loginAs(user: string) {
    await this.goto();
    await this.login(user);
    await expect(this.page).toHaveURL(/\/inventory\.html$/);
  }
}
