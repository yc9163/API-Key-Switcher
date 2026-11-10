// Wrangler bundles *.html imports as text (its default module rules).
declare module '*.html' {
  const text: string;
  export default text;
}
