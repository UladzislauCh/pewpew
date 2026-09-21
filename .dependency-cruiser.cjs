/**
 * Import rules for the feature-based layout — docs/adr/0001, docs/adr/0002.
 * Direction: app → pages → features → domain → shared.
 * Only the new layout's folders are checked; old files don't break the build until moved.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'shared-imports-only-shared',
      comment: 'shared knows nothing about the product: only imports shared',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/', pathNot: '^src/shared/' },
    },
    {
      name: 'domain-no-upper-layers',
      comment: 'domain does not import app, pages, features',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: { path: '^src/(app|pages|features)/' },
    },
    {
      name: 'domain-no-react-or-store',
      comment: 'domain is logic without React and without the store',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: { path: '(^node_modules/(react|react-dom|react-router|react-i18next|zustand)/|^src/shared/store/)' },
    },
    {
      name: 'features-no-upper-layers',
      comment: 'features do not import app and pages',
      severity: 'error',
      from: { path: '^src/features/' },
      to: { path: '^src/(app|pages)/' },
    },
    {
      name: 'feature-not-other-feature',
      comment: 'a feature does not import another feature — shared code moves down to domain or shared',
      severity: 'error',
      from: { path: '^src/features/([^/]+)/' },
      to: { path: '^src/features/', pathNot: '^src/features/$1/' },
    },
    {
      name: 'pages-no-app',
      comment: 'pages do not import app',
      severity: 'error',
      from: { path: '^src/pages/' },
      to: { path: '^src/app/' },
    },
    {
      name: 'feature-only-via-index',
      comment: 'from outside, a feature is only opened through its own index.ts',
      severity: 'error',
      from: { pathNot: '^src/features/([^/]+)/' },
      to: { path: '^src/features/[^/]+/.+', pathNot: '^src/features/[^/]+/index\\.tsx?$' },
    },
    {
      name: 'no-circular-in-new-layout',
      comment: 'cycles are forbidden in the new layout',
      severity: 'error',
      from: { path: '^src/(app|pages|features|domain|shared)/' },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.test\\.tsx?$' },
    tsConfig: { fileName: 'tsconfig.app.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default', 'types'] },
  },
}
