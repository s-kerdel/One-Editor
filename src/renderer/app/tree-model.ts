// Pure, immutable helpers for the file tree signal. Only nodes on the changed path are copied, so
// patching a 50k-file tree for one event is O(depth + siblings), and Preact re-renders minimally.
import type { TreeNode } from '@shared/api';
import { basename, dirname } from '@shared/paths';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const compareNodes = (a: TreeNode, b: TreeNode) => (a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : collator.compare(a.name, b.name));

export function findNode(tree: TreeNode | null, path: string): TreeNode | null {
  if (!tree) return null;
  if (!path) return tree;
  let node: TreeNode | undefined = tree;
  for (const seg of path.split('/')) {
    node = node?.children?.find((c) => c.name === seg);
    if (!node) return null;
  }
  return node;
}

/** Copy-on-write update of the dir at `dirPath` (created, with parents, if missing). */
function updateDir(tree: TreeNode, dirPath: string, fn: (dir: TreeNode) => TreeNode): TreeNode {
  if (!dirPath) return fn(tree);
  const [head, ...rest] = dirPath.split('/');
  const children = tree.children ?? [];
  const childPath = tree.path ? `${tree.path}/${head}` : head;
  let child = children.find((c) => c.name === head);
  const existed = !!child;
  if (!child || child.kind !== 'dir') child = { name: head, path: childPath, kind: 'dir', children: [] };
  const updated = updateDir(child, rest.join('/'), fn);
  const next = existed ? children.map((c) => (c.name === head ? updated : c)) : [...children, updated].sort(compareNodes);
  return { ...tree, children: next };
}

export function insertNode(tree: TreeNode, node: TreeNode): TreeNode {
  return updateDir(tree, dirname(node.path), (dir) => {
    const children = dir.children ?? [];
    const existing = children.find((c) => c.name === node.name);
    if (existing && existing.kind === node.kind && node.kind === 'dir' && !node.children?.length) return dir; // keep known children
    const rest = children.filter((c) => c.name !== node.name);
    return { ...dir, children: [...rest, node].sort(compareNodes) };
  });
}

export function removeNode(tree: TreeNode, path: string): TreeNode {
  if (!path || !findNode(tree, path)) return tree;
  const name = basename(path);
  return updateDir(tree, dirname(path), (dir) => ({ ...dir, children: (dir.children ?? []).filter((c) => c.name !== name) }));
}

/** Re-roots a subtree at a new path (rename / move). */
export function repath(node: TreeNode, to: string): TreeNode {
  const out: TreeNode = { ...node, path: to, name: basename(to) };
  if (node.children) out.children = node.children.map((c) => repath(c, `${to}/${c.name}`));
  return out;
}

export function moveNode(tree: TreeNode, from: string, to: string): TreeNode {
  const node = findNode(tree, from);
  if (!node) return tree;
  return insertNode(removeNode(tree, from), repath(node, to));
}

export function replaceSubtree(tree: TreeNode, sub: TreeNode): TreeNode {
  if (!sub.path) return { ...sub, name: tree.name };
  return insertNode(removeNode(tree, sub.path), sub);
}

export function filesUnder(node: TreeNode | null): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    if (n.kind === 'file') out.push(n.path);
    else n.children?.forEach(walk);
  };
  if (node) walk(node);
  return out;
}

export interface Row {
  node: TreeNode;
  depth: number;
  expanded: boolean;
  /** Placeholder row for the inline "new file/folder" input. */
  create?: 'file' | 'dir';
}

/**
 * Visible rows in display order. With a filter, shows matches plus their ancestors (all expanded).
 * `creating` inserts an input row as the first child of that folder.
 */
export function flattenTree(tree: TreeNode | null, expanded: ReadonlySet<string>, filter = '', creating: { parent: string; kind: 'file' | 'dir' } | null = null): Row[] {
  const rows: Row[] = [];
  if (!tree) return rows;
  const q = filter.trim().toLowerCase();
  const matches = (n: TreeNode): boolean => (n.kind === 'file' ? n.name.toLowerCase().includes(q) : n.name.toLowerCase().includes(q) || !!n.children?.some(matches));
  const createRow = (parent: TreeNode, depth: number) => {
    if (creating && creating.parent === parent.path) rows.push({ node: { name: '', path: `${parent.path ? parent.path + '/' : ''}\u0000new`, kind: creating.kind }, depth, expanded: false, create: creating.kind });
  };
  const walk = (dir: TreeNode, depth: number) => {
    createRow(dir, depth);
    for (const c of dir.children ?? []) {
      if (q && !matches(c)) continue;
      const open = c.kind === 'dir' && (q ? true : expanded.has(c.path) || creating?.parent === c.path);
      rows.push({ node: c, depth, expanded: open });
      if (open) walk(c, depth + 1);
    }
  };
  walk(tree, 0);
  return rows;
}

/** Ancestor folder paths of a file ("a/b/c.md" → ["a", "a/b"]). */
export function ancestors(path: string): string[] {
  const parts = path.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}
