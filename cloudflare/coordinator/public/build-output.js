// Copy the entire rendered log, including the lines outside its scroll viewport.
export function attachOutputCopy(button, output, status) {
  button.addEventListener('click', async () => {
    const text = output.textContent;
    if (!text) { status.textContent = 'No output to copy yet.'; return; }
    status.textContent = '';
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'Copied output.';
    } catch {
      // Browsers can deny clipboard access. Select the log for the usual copy shortcut.
      output.focus();
      const range = document.createRange();
      range.selectNodeContents(output);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = 'Output selected. Press Ctrl+C (Command+C on Mac) to copy.';
    }
  });
}
