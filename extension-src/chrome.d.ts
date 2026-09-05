/* Minimal ambient typing for the subset of the chrome.* API the content script uses. */
declare namespace chrome.runtime {
  const lastError: { message?: string } | undefined;
  function sendMessage(message: unknown, responseCallback: (response: unknown) => void): void;
}
