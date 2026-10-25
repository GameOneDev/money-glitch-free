# money-glitch-free

Tamper Monkey: [install](https://raw.githubusercontent.com/GameOneDev/money-glitch-free/main/kahoot-ai-claude.user.js)

Works on Kahoot (kahoot.it), Mentimeter quizzes (menti.com, multiple-choice quiz questions; polls are left alone) and AhaSlides quizzes (audience.ahaslides.com). The API key is saved per site, so paste it once on each.

On Menti the whole quiz is known when the voting page loads, so Claude answers the quiz questions still to come in the background while you wait, and each answer is ready when its question comes up. The "Answer ahead" switch in the panel turns that off (it costs one request per question, including questions the quiz never gets to).

Web search is on, and Claude is told to always search before it answers: asked about recent or local facts (how many shops a chain has, when its first one opened) it otherwise answers from memory, confidently and wrongly. A search takes a few seconds, so unless its answer is already in, the question is also asked without searching, and if the search is still out 4 s after the question is up (or fails), that quick answer is used and the panel says so. It is not cheap: a search is 1 cent and its results add about 15,000 input tokens, so a question costs about 4 cents on Sonnet 5.5 (7 on Opus 5.5, 1 to 2 on Haiku 5.5), 80 cents for a 20 question quiz on Sonnet. The "Web search" switch turns it off, and a spend limit on the key is a good idea. An install from before 4.7 where the model and web search were never changed stays on Haiku 5.5 without search; both are in the panel.

On AhaSlides it answers multiple choice (including questions with several right answers), short answer, correct order, match pairs and categorise slides, live or self-paced. Pictures on the question, the answers or the matches go to Claude along with the text.
