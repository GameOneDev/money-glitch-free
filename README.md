# money-glitch-free

Tamper Monkey: [install](https://raw.githubusercontent.com/GameOneDev/money-glitch-free/main/kahoot-ai-claude.user.js)

Works on Kahoot (kahoot.it), Mentimeter quizzes (menti.com, multiple-choice quiz questions; polls are left alone) and AhaSlides quizzes (audience.ahaslides.com). The API key is saved per site, so paste it once on each.

On Menti the whole quiz is known when the voting page loads, so Claude answers every quiz question in the background while you wait, and each answer is ready when its question comes up. The "Answer ahead" switch in the panel turns that off (it costs one request per question).

Web search is on, and Claude is told to always search before it answers: asked about recent or local facts (how many shops a chain has, when its first one opened) it otherwise answers from memory, confidently and wrongly. Each search is billed (about 1 cent) and adds a few seconds, so the question is also asked without searching, and if the search is still out 4 s after the question is up, that quick answer is used. The "Web search" switch turns it off.

On AhaSlides it answers multiple choice (including questions with several right answers), short answer, correct order, match pairs and categorise slides, live or self-paced. Pictures on the question, the answers or the matches go to Claude along with the text.
