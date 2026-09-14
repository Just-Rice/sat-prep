# SAT Prep

An adaptive SAT study app that runs entirely in the browser.

**Live demo: https://just-rice.github.io/sat-prep/**

- **Placement test** that adapts question difficulty as you answer, then estimates a score range and skill breakdown
- **Grade-level mode** (grades 8–12) as an alternative starting point
- **Adaptive practice** that targets your weakest skills at about a 70% success rate, with explanations after each question
- **Timed practice tests** built like the digital SAT: two modules per section, with module 2 routed harder or easier by your module 1 results
- **Test-day tools**: timer, flag for review, answer eliminator, passage highlighter, question navigator, calculator and formula reference
- **Mistake log and spaced review**: tag why you missed a question; it comes back after 1, 3, 7, 14 and 30 days
- **Dashboard and study plan**: skill mastery, score estimates, daily goal and streak, and a routine based on your test date and target

All progress is stored locally in your browser (`localStorage`) — nothing is sent to a server.

## Running it locally

Requires Node.js.

```sh
npm start      # http://localhost:5190
npm test       # engine tests
```

## Questions

The hosted version on GitHub Pages ships with a small set of original demo questions, since real
College Board content can't be redistributed.

For a real question library, export PDFs yourself from the official
[SAT Suite Educator Question Bank](https://satsuiteeducatorquestionbank.collegeboard.org/), drop them in an
`exports/` folder, and run `npm start` (or `npm run build`). The build step parses each PDF into
`data/questions.json` plus cropped images for parts that contain math, graphs or tables; both `exports/`
and `data/` are gitignored, so no College Board content is ever committed to this repository.

Score ranges are estimates from a Rasch (IRT) model over College Board's Easy/Medium/Hard labels, not
official scores.

## Calculator

The digital SAT uses the Desmos graphing calculator, which requires an API key to embed
([desmos.com/my-api](https://www.desmos.com/my-api)). Paste a key in Library → Settings to use it; otherwise a
built-in scientific calculator is used.
