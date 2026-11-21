// Name rules and tree moves for the file actions in ./Popups (create, rename, move, delete). Only that
// lazy chunk imports this module, so it rides in the Popups chunk: no startup bytes, no extra chunk.
import type { TreeNode } from '@shared/api';
import { basename } from '@shared/paths';
import { app } from './app';
import { findNode, insertNode, removeNode } from './tree-model';

const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Returns an error message, or null if `name` is a valid single path segment on every OS we support. */
export function validateName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Name cannot be empty';
  if (n === '.' || n === '..') return 'Invalid name';
  if (/[\\/]/.test(n)) return 'Name cannot contain / or \\';
  if (/[<>:"|?*\u0000-\u001f]/.test(n)) return 'Name cannot contain < > : " | ? *';
  if (/[. ]$/.test(n)) return 'Name cannot end with a dot or space';
  if (WIN_RESERVED.test(n)) return `"${n}" is reserved on Windows`;
  return null;
}

export function trashName() {
  return app.backend?.os === 'win32' ? 'Recycle Bin' : 'Trash';
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
