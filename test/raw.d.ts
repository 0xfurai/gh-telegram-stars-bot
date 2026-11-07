// Vite's `?raw` imports load a file's text, for tests that check files such as
// .dev.vars.example.
declare module "*?raw" {
  const content: string;
  export default content;
}
