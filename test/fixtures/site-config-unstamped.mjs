/** a site rehype plugin that prepends a block carrying no source position
 *  where no gap can place it — a block the editor cannot reach */
function rehypeBanner() {
  return (tree) => {
    tree.children.unshift({ type: 'element', tagName: 'div', properties: { className: ['banner'] }, children: [] });
  };
}

export const rehypePlugins = [rehypeBanner];
