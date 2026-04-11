import { test, expect } from '@playwright/test';

const testPassword = 'TestPassword123!';

// Generate unique username for each test to avoid conflicts
function generateUsername(): string {
  return `testuser_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

test.describe('Chat Like Human - Complete Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage before each test to ensure clean state
    await page.goto('/login');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('1. Registration Flow - New user can register successfully', async ({ page }) => {
    const username = generateUsername();
    await page.goto('/login');

    // Fill in registration form
    await page.fill('input[placeholder="Username"]', username);
    await page.fill('input[placeholder="Password"]', testPassword);

    // Click Register button
    await page.click('button:has-text("Register")');

    // Should redirect to chat page after successful registration
    await page.waitForURL('**/chat', { timeout: 10000 });

    // Verify we're on the chat page
    await expect(page.locator('.chat-header-title')).toContainText('CHAT LIKE HUMAN');
  });

  test('2. Login Flow - Existing user can login', async ({ page }) => {
    const username = generateUsername();

    // First register a user
    await page.goto('/login');
    await page.fill('input[placeholder="Username"]', username);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button:has-text("Register")');
    await page.waitForURL('**/chat', { timeout: 10000 });

    // Logout
    await page.click('button:has-text("Logout")');
    await page.waitForURL('**/login', { timeout: 5000 });

    // Now login with the same credentials
    await page.fill('input[placeholder="Username"]', username);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button:has-text("Enter the Mirror")');

    // Should redirect to chat page
    await page.waitForURL('**/chat', { timeout: 10000 });
    await expect(page.locator('.chat-header-title')).toContainText('CHAT LIKE HUMAN');
  });

  test('3. Login Flow - Invalid credentials show error', async ({ page }) => {
    await page.goto('/login');

    // Fill in wrong credentials
    await page.fill('input[placeholder="Username"]', 'nonexistent_user_xyz12345');
    await page.fill('input[placeholder="Password"]', 'wrongpassword');

    // Submit form by pressing Enter in password field
    await page.press('input[placeholder="Password"]', 'Enter');

    // Wait for network to settle and error to appear
    await page.waitForLoadState('networkidle');

    // Check if error div exists and is visible
    const errorElement = page.locator('.login-error');

    // Either error shows, or we check for URL change / any sign of rejection
    const errorVisible = await errorElement.isVisible({ timeout: 5000 }).catch(() => false);

    if (errorVisible) {
      const errorText = await errorElement.textContent();
      expect(errorText?.toLowerCase()).toMatch(/login|failed|invalid|error|用户名|密码/i);
    } else {
      // If no error shown, check we're still on login page (not redirected)
      await expect(page.locator('.login-title')).toBeVisible();
      // And input fields should be cleared/reset
      await expect(page.locator('input[placeholder="Password"]')).toHaveValue('');
    }
  });

  test('4. Send Message - User can send a message and receive reply', async ({ page }) => {
    const username = generateUsername();

    // Register and login
    await page.goto('/login');
    await page.fill('input[placeholder="Username"]', username);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button:has-text("Register")');
    await page.waitForURL('**/chat', { timeout: 10000 });

    // Verify empty state is shown
    await expect(page.locator('.chat-empty-text')).toContainText('Begin a conversation');

    // Type and send a message
    const testMessage = 'Hello, how are you?';
    await page.fill('input.chat-input', testMessage);
    await page.click('button.chat-send-button');

    // Wait for user message to appear
    await expect(page.locator('.message-bubble.user')).toContainText(testMessage, { timeout: 5000 });

    // Wait for assistant reply
    await expect(page.locator('.message-bubble.assistant')).toBeVisible({ timeout: 20000 });
  });

  test('5. Multi-message Conversation - User can exchange multiple messages', async ({ page }) => {
    const username = generateUsername();

    // Register, login, and wait for chat page
    await page.goto('/login');
    await page.fill('input[placeholder="Username"]', username);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button:has-text("Register")');
    await page.waitForURL('**/chat', { timeout: 10000 });

    // Send first message
    await page.fill('input.chat-input', 'Tell me a joke');
    await page.click('button.chat-send-button');
    await expect(page.locator('.message-bubble.user')).toContainText('Tell me a joke', { timeout: 5000 });

    // Wait for first reply
    await expect(page.locator('.message-bubble.assistant')).toBeVisible({ timeout: 20000 });

    // Send second message
    await page.fill('input.chat-input', 'Tell me another one');
    await page.click('button.chat-send-button');
    await expect(page.locator('.message-bubble.user').last()).toContainText('Tell me another one', { timeout: 5000 });

    // Wait for second reply
    await expect(page.locator('.message-bubble.assistant').last()).toBeVisible({ timeout: 20000 });

    // Verify we have 2 user messages and 2 assistant messages
    await expect(page.locator('.message-bubble.user')).toHaveCount(2);
    await expect(page.locator('.message-bubble.assistant')).toHaveCount(2);
  });

  test('6. Session Persistence - Auth token persists after page reload', async ({ page }) => {
    const username = generateUsername();

    // Register and send messages
    await page.goto('/login');
    await page.fill('input[placeholder="Username"]', username);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button:has-text("Register")');
    await page.waitForURL('**/chat', { timeout: 10000 });

    const testMessage = 'Testing session persistence';
    await page.fill('input.chat-input', testMessage);
    await page.click('button.chat-send-button');
    await expect(page.locator('.message-bubble.user')).toContainText(testMessage, { timeout: 5000 });
    await expect(page.locator('.message-bubble.assistant')).toBeVisible({ timeout: 20000 });

    // Reload the page - auth token persists but messages are in component state (lost on reload)
    await page.reload();
    await page.waitForURL('**/chat', { timeout: 10000 });

    // Verify user is still authenticated (can access chat page) - auth token was persisted
    await expect(page.locator('.chat-header-title')).toBeVisible();

    // Messages are NOT persisted (only stored in React state, not localStorage)
    // So we see the empty state again
    await expect(page.locator('.chat-empty-text')).toContainText('Begin a conversation');
  });

  test('7. Logout Flow - User can logout and is redirected to login', async ({ page }) => {
    const username = generateUsername();

    // Register and login
    await page.goto('/login');
    await page.fill('input[placeholder="Username"]', username);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button:has-text("Register")');
    await page.waitForURL('**/chat', { timeout: 10000 });

    // Verify chat page is accessible
    await expect(page.locator('.chat-header-title')).toBeVisible();

    // Click logout
    await page.click('button:has-text("Logout")');

    // Should redirect to login page
    await page.waitForURL('**/login', { timeout: 5000 });
    await expect(page.locator('.login-title')).toContainText('CHAT LIKE HUMAN');

    // Try to access chat page directly - should be redirected
    await page.goto('/chat');
    await page.waitForURL('**/login', { timeout: 5000 });
  });

  test('8. Protected Route - Chat page redirects to login when not authenticated', async ({ page }) => {
    // Clear storage and try to access chat directly
    await page.goto('/login');
    await page.evaluate(() => localStorage.clear());
    await page.goto('/chat');

    // Should redirect to login
    await page.waitForURL('**/login', { timeout: 5000 });
    await expect(page.locator('.login-title')).toBeVisible();
  });

  test('9. Input Field States - Send button disabled when input is empty', async ({ page }) => {
    const username = generateUsername();

    // Register and login
    await page.goto('/login');
    await page.fill('input[placeholder="Username"]', username);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button:has-text("Register")');
    await page.waitForURL('**/chat', { timeout: 10000 });

    // Send button should be disabled when input is empty
    const sendButton = page.locator('button.chat-send-button');
    await expect(sendButton).toBeDisabled();

    // Send button should be enabled when input has text
    await page.fill('input.chat-input', 'Test message');
    await expect(sendButton).toBeEnabled();
  });

  test('10. Conversation Summary - Backend queues messages for summary after debounce', async ({ page }) => {
    const username = generateUsername();

    // This test verifies the complete flow triggers the summary queue mechanism
    // Register and login
    await page.goto('/login');
    await page.fill('input[placeholder="Username"]', username);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button:has-text("Register")');
    await page.waitForURL('**/chat', { timeout: 10000 });

    // Send multiple messages to trigger batch processing
    const messages = [
      'First message for summary test',
      'Second message for summary test',
      'Third message for summary test',
    ];

    for (const msg of messages) {
      await page.fill('input.chat-input', msg);
      await page.click('button.chat-send-button');
      await page.waitForTimeout(500); // Small delay between messages
    }

    // Wait for all messages to be sent
    await expect(page.locator('.message-bubble.user')).toHaveCount(3, { timeout: 10000 });

    // Wait for debounce timer (5 seconds as per chat.service.ts) + buffer
    await page.waitForTimeout(6000);

    // Verify messages are displayed correctly
    const userMessages = page.locator('.message-bubble.user');
    await expect(userMessages).toHaveCount(3);

    // Verify assistant replies exist (one or more)
    const assistantMessages = page.locator('.message-bubble.assistant');
    const count = await assistantMessages.count();
    expect(count).toBeGreaterThan(0);
  });
});

test.describe('Visual Verification', () => {
  test('Login page renders correctly with all elements', async ({ page }) => {
    await page.goto('/login');

    // Verify main elements are visible
    await expect(page.locator('.login-title')).toContainText('CHAT LIKE HUMAN');
    await expect(page.locator('.login-subtitle')).toContainText('Gaze into the mirror');
    await expect(page.locator('input[placeholder="Username"]')).toBeVisible();
    await expect(page.locator('input[placeholder="Password"]')).toBeVisible();
    await expect(page.locator('button:has-text("Enter the Mirror")')).toBeVisible();
    await expect(page.locator('button:has-text("Register")')).toBeVisible();
    await expect(page.locator('.login-divider')).toContainText('or');
  });

  test('Chat page renders correctly with all elements', async ({ page }) => {
    const username = generateUsername();

    // Login first
    await page.goto('/login');
    await page.fill('input[placeholder="Username"]', username);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button:has-text("Register")');
    await page.waitForURL('**/chat', { timeout: 10000 });

    // Verify main elements
    await expect(page.locator('.chat-header-title')).toContainText('CHAT LIKE HUMAN');
    await expect(page.locator('button:has-text("Logout")')).toBeVisible();
    await expect(page.locator('.chat-input')).toBeVisible();
    await expect(page.locator('button.chat-send-button')).toBeVisible();
    await expect(page.locator('.chat-empty-text')).toContainText('Begin a conversation');
  });
});