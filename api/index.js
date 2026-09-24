// Vercel serverless entrypoint: re-exports the Express app (no app.listen here).
// Vercel's Fluid runtime invokes this function per request.
const app = require('../server');

module.exports = app;
