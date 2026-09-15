# Test Prep

An adaptive study app for the SAT, PSAT and ACT that runs entirely in the browser.

**Live site: https://just-rice.github.io/sat-prep/**

- **Four tests, each with its own progress:** the SAT, PSAT/NMSQT and PSAT 10, PSAT 8/9, and the ACT
- **Placement test** that adapts question difficulty as you answer, or a grade-level starting point
- **Adaptive practice** that targets your weakest skills at about a 70% success rate, with explanations
- **Timed practice tests** in each test's format: two adaptive modules per section for the SAT Suite, and one
  timed block per section for the ACT (Science optional, outside the Composite)
- **Test-day tools:** timer, flag for review, answer eliminator, passage highlighter, question navigator,
  Desmos calculator and formula reference
- **Mistake log and spaced review:** tag why you missed a question; it comes back after 1, 3, 7, 14 and 30 days
- **Dashboard** with today's plan, a sortable skills table, your streak and review queue, and a **Scores** page
  with your estimate on the real scale and a trend of your practice tests
- **Cloud sync** with Google or a username and passcode, so progress follows you between devices

Progress is stored in your browser; with sync on, it is also saved to your own Firebase account.

## Running it locally

Requires Node.js.

```sh
npm start      # builds the question library, then serves http://localhost:5190
npm test       # engine, sync and deploy tests
```

## Questions

The hosted site ships with a small set of original demo questions, since official test content can't be
redistributed. For a real question library:

- **SAT and PSAT:** export PDFs yourself from the official
  [SAT Suite Educator Question Bank](https://satsuiteeducatorquestionbank.collegeboard.org/) and save them in
  `exports/`. Each question is sorted into the SAT, PSAT/NMSQT or PSAT 8/9 by the assessment it lists.
- **ACT (still being built):** the ACT's sections, skills, scoring and timed format are in place, but reading ACT's
  free official practice test PDFs from [act.org](https://www.act.org/) isn't finished yet, so the ACT has no questions.

`npm start` (or `npm run build`) parses the PDFs into `data/questions.json` plus cropped images for parts that
contain math, graphs or tables. `exports/` and `data/` are gitignored, so no official content is ever committed.

Score ranges are estimates from a Rasch (IRT) model and each test's scale, not official scores.
