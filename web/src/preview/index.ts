// Phase 3 preview barrel. Downstream specs import via `'./preview'`
// rather than reaching into the directory's internals; this keeps the
// public surface explicit and lets future refactors move files around
// without breaking callers.

export { default as PreviewPage } from './PreviewPage';
export { default as Scene } from './Scene';
