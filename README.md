# SAT Prep

Personal, local-only SAT study tool:

- **Placement test** that adapts question difficulty as you answer, then estimates a score range and skill breakdown
- **Grade-level mode** (grades 8–12) as an alternative starting point
- **Adaptive practice** that targets your weakest skills at about a 70% success rate, with explanations after each question
- **Timed practice tests** built like the digital SAT: two modules per section, with module 2 routed harder or easier by your module 1 results
- **Test-day tools**: timer, flag for review, answer eliminator, passage highlighter, question navigator, calculator and formula reference
- **Mistake log and spaced review**: tag why you missed a question; it comes back after 1, 3, 7, 14 and 30 days
- **Dashboard and study plan**: skill mastery, score estimates, daily goal and streak, and a routine based on your test date and target

## Running it

Requires Node.js. No install step is needed to run the app.

```sh
npm start      # http://localhost:5190
npm test       # engine tests
```

## Questions

Questions come from PDFs you export yourself from the official
[SAT Suite Educator Question Bank](https://satsuiteeducatorquestionbank.collegeboard.org/) and import on the
Library page. They are parsed in your browser and stored only in that browser. **No College Board content is
stored in this repository**, and `.gitignore` excludes PDFs and the `samples/` and `imports/` folders.

The PDF parser is not finished yet: it needs a real export to be built against. Until then, the Library page
can load a small set of original demo questions to try every feature.

Score ranges are estimates from a Rasch model over College Board's Easy/Medium/Hard labels, not official scores.

## Calculator

The digital SAT uses the Desmos graphing calculator, which requires an API key to embed
([desmos.com/my-api](https://www.desmos.com/my-api)). Paste a key in Library → Settings to use it; otherwise a
built-in scientific calculator is used.
