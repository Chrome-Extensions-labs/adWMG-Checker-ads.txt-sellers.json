/** Render large lists in cancellable batches without blocking every control. */
async function renderInBatches(container, items, renderItem, signal, batchSize = 400) {
  throwIfCancelled(signal);
  container.replaceChildren();
  for (let start = 0; start < items.length; start += batchSize) {
    throwIfCancelled(signal);
    const fragment = document.createDocumentFragment();
    for (let i = start; i < Math.min(start + batchSize, items.length); i++) {
      const node = renderItem(items[i], i);
      if (node) fragment.appendChild(node);
    }
    container.appendChild(fragment);
    if (start + batchSize < items.length) await yieldTask(signal);
  }
}
