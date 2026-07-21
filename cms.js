(() => {
  async function applyPageImages() {
    const nodes = document.querySelectorAll('[data-page-image]');
    if (!nodes.length) return;

    try {
      const res = await fetch('/api/page-images');
      if (!res.ok) return;
      const data = await res.json();
      const slots = data.pageImages || {};

      nodes.forEach(node => {
        const config = slots[node.dataset.pageImage];
        if (!config) return;

        const wrapper = node.closest('[data-page-image-wrapper]');
        const target = wrapper || node;

        if (config.hidden) {
          target.style.display = 'none';
          return;
        }

        target.style.display = '';
        if (config.url) node.src = config.url;
      });
    } catch (error) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyPageImages);
  } else {
    applyPageImages();
  }
})();
