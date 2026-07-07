(function () {
  'use strict';

  var ROUNDS = 10;

  var GAME_LABELS = {
    whoseCast:     'Whose Cast?',
    nameTheDecade: 'Name the Decade',
    fillTheBill:   'Fill the Bill',
    boxOffice:     'Box Office or Bust?',
    whoseHouse:    'Whose House?',
    debutDecade:   'Debut Decade',
    playsHome:     "Play’s Home",
    longRunner:    'Long Runner or Flash?',
    openingNight:  'Opening Night'
  };

  var state = {
    mode:      null,
    questions: [],
    round:     0,
    score:     0,
    answered:  false
  };

  var $lobby      = document.getElementById('games-lobby');
  var $arena      = document.getElementById('games-arena');
  var $end        = document.getElementById('games-end');
  var $loading    = document.getElementById('games-loading');
  var $titleLabel = document.getElementById('game-title-label');
  var $score      = document.getElementById('game-score');
  var $round      = document.getElementById('game-round');
  var $question   = document.getElementById('game-question');
  var $cast       = document.getElementById('game-cast');
  var $options    = document.getElementById('game-options');
  var $feedback   = document.getElementById('game-feedback');
  var $nextBtn    = document.getElementById('game-next');
  var $backBtn    = document.getElementById('game-back');
  var $endScore   = document.getElementById('games-end-score');
  var $endMsg     = document.getElementById('games-end-msg');
  var $playAgain  = document.getElementById('games-play-again');
  var $changeGame = document.getElementById('games-change');

  var questionsCache = null;

  function loadQuestions(cb) {
    if (questionsCache) { cb(questionsCache); return; }
    show($loading);
    fetch('data/games/questions.json')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        questionsCache = data;
        hide($loading);
        cb(data);
      })
      .catch(function (err) {
        hide($loading);
        $question.textContent = 'Could not load questions — please check your connection.';
        console.error('games.js: failed to load questions.json', err);
      });
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function show(el) { el.hidden = false; }
  function hide(el) { el.hidden = true; }

  function fmtDate(yyyymmdd) {
    var s = String(yyyymmdd);
    if (s.length !== 8) return s;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var y = s.slice(0, 4);
    var m = parseInt(s.slice(4, 6), 10) - 1;
    var d = parseInt(s.slice(6, 8), 10);
    return d + ' ' + months[m] + ' ' + y;
  }

  // ─── GAME FLOW ──────────────────────────────────────────────────────────────

  function startGame(mode, allQuestions) {
    state.mode     = mode;
    state.round    = 0;
    state.score    = 0;
    state.answered = false;

    var pool = allQuestions[mode] ? allQuestions[mode].slice() : [];
    shuffle(pool);
    state.questions = pool.slice(0, ROUNDS);

    if (state.questions.length === 0) {
      alert('No questions available for this game mode.');
      return;
    }

    $titleLabel.textContent = GAME_LABELS[mode] || mode;
    hide($lobby);
    hide($end);
    show($arena);
    renderQuestion();
  }

  function renderQuestion() {
    var q = state.questions[state.round];
    state.answered = false;

    $score.textContent = state.score + ' / ' + state.round;
    $round.textContent = 'Round ' + (state.round + 1) + ' of ' + state.questions.length;
    hide($feedback);
    hide($nextBtn);
    $cast.textContent = '';
    $cast.hidden = true;
    $options.innerHTML = '';

    // Default cast aria-label; modes override for non-cast contexts.
    $cast.setAttribute('aria-label', 'Cast list');

    if (state.mode === 'whoseCast') {
      renderWhoseCast(q);
    } else if (state.mode === 'nameTheDecade') {
      renderNameTheDecade(q);
    } else if (state.mode === 'fillTheBill') {
      renderFillTheBill(q);
    } else if (state.mode === 'boxOffice') {
      renderBoxOffice(q);
    } else if (state.mode === 'whoseHouse') {
      renderWhoseHouse(q);
    } else if (state.mode === 'debutDecade') {
      renderDebutDecade(q);
    } else if (state.mode === 'playsHome') {
      renderPlaysHome(q);
    } else if (state.mode === 'longRunner') {
      renderLongRunner(q);
    } else if (state.mode === 'openingNight') {
      renderOpeningNight(q);
    }
  }

  function renderWhoseCast(q) {
    var theatre = q.theatre ? ' at ' + q.theatre : '';
    $question.textContent = 'In the ' + q.decade + 's' + theatre + ', these performers shared the stage:';

    $cast.hidden = false;
    $cast.innerHTML = '';
    q.performers.forEach(function (name) {
      var li = document.createElement('div');
      li.className = 'game-cast-name';
      li.textContent = '— ' + name;
      $cast.appendChild(li);
    });

    buildOptions(q.options, q.answer, 'Which play were they performing?');
  }

  function renderNameTheDecade(q) {
    $question.textContent = '“' + q.work + '”';
    buildOptions(
      q.options.map(function (d) { return d + 's'; }),
      q.answer,
      'In which decade was this play most often staged?'
    );
  }

  function renderFillTheBill(q) {
    $question.textContent = 'In the ' + q.decade + 's, “' + q.mainpiece + '” was most often billed with which afterpiece?';
    buildOptions(q.options, q.answer);
  }

  function renderBoxOffice(q) {
    $question.textContent = 'Two nights at ' + q.venue + ':';

    $cast.hidden = false;
    $cast.innerHTML = '';
    $cast.setAttribute('aria-label', 'Two nights compared');

    var labels = ['Night A', 'Night B'];
    [q.a, q.b].forEach(function (night, i) {
      var div = document.createElement('div');
      div.className = 'game-cast-name';
      div.textContent = labels[i] + ' — ' + fmtDate(night.date) + ' — “' + night.title + '”';
      $cast.appendChild(div);
    });

    buildOptions(['Night A', 'Night B'], q.answer, 'Which evening took more at the box office?');
  }

  function renderWhoseHouse(q) {
    $question.textContent = 'In the ' + q.decade + 's, at which playhouse did ' + q.performer + ' appear most often?';
    buildOptions(q.options, q.answer);
  }

  function renderDebutDecade(q) {
    $question.textContent = '"' + q.performer + '"';
    buildOptions(
      q.options.map(function (d) { return d + 's'; }),
      q.answer,
      'In which decade did this performer first appear on the London stage?'
    );
  }

  function renderPlaysHome(q) {
    $question.textContent = 'In the ' + q.decade + 's, at which playhouse was “' + q.work + '” most often staged?';
    buildOptions(q.options, q.answer);
  }

  function renderLongRunner(q) {
    $question.textContent = 'Both plays appeared on the London stage in the ' + q.decade + 's:';
    buildOptions([q.a, q.b], q.answer, 'Across all 141 seasons, which had more recorded performances?');
  }

  function renderOpeningNight(q) {
    $question.textContent = '“' + q.work + '”';
    buildOptions(
      q.options.map(function (d) { return d + 's'; }),
      q.answer,
      'In which decade did this play first appear on the London stage?'
    );
  }

  function buildOptions(options, correctIdx, labelText) {
    if (labelText) {
      var lbl = document.createElement('p');
      lbl.className = 'game-options-label metadata-label';
      lbl.textContent = labelText;
      $options.appendChild(lbl);
    }

    options.forEach(function (text, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'game-option';
      btn.textContent = text;
      btn.dataset.idx = i;
      btn.addEventListener('click', function () { selectAnswer(i, correctIdx, options[correctIdx]); });
      $options.appendChild(btn);
    });
  }

  function selectAnswer(chosen, correctIdx, correctLabel) {
    if (state.answered) return;
    state.answered = true;

    var isCorrect = chosen === correctIdx;
    if (isCorrect) state.score++;

    var btns = $options.querySelectorAll('.game-option');
    btns.forEach(function (btn) {
      var idx = parseInt(btn.dataset.idx, 10);
      btn.disabled = true;
      if (idx === correctIdx) {
        btn.classList.add('is-correct');
      } else if (idx === chosen && !isCorrect) {
        btn.classList.add('is-wrong');
      }
    });

    $feedback.hidden = false;
    if (isCorrect) {
      $feedback.textContent = 'Correct.';
      $feedback.className = 'game-feedback is-correct';
    } else {
      $feedback.textContent = 'Wrong — it was “' + correctLabel + '”.';
      $feedback.className = 'game-feedback is-wrong';
    }

    $score.textContent = state.score + ' / ' + (state.round + 1);

    if (state.round + 1 < state.questions.length) {
      show($nextBtn);
    } else {
      var nextBtn = $nextBtn;
      nextBtn.textContent = 'See results →';
      show(nextBtn);
    }
  }

  function nextQuestion() {
    state.round++;
    if (state.round >= state.questions.length) {
      showEnd();
    } else {
      $nextBtn.textContent = 'Next →';
      renderQuestion();
    }
  }

  function showEnd() {
    hide($arena);
    show($end);

    var total = state.questions.length;
    $endScore.textContent = state.score + ' / ' + total;

    var pct = total > 0 ? state.score / total : 0;
    var msg;
    if (pct >= 0.9) {
      msg = 'Excellent — a true connoisseur of the London stage.';
    } else if (pct >= 0.7) {
      msg = 'Well done — a well-read frequenter of the pit.';
    } else if (pct >= 0.5) {
      msg = 'Not bad — the gallery appreciates the effort.';
    } else {
      msg = 'Perhaps another night will go better.';
    }
    $endMsg.textContent = msg;
  }

  // ─── EVENTS ─────────────────────────────────────────────────────────────────

  document.querySelectorAll('.game-card').forEach(function (card) {
    function activate() {
      var mode = card.dataset.game;
      if (!mode) return;
      loadQuestions(function (data) { startGame(mode, data); });
    }
    card.addEventListener('click', activate);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
  });

  $nextBtn.addEventListener('click', nextQuestion);

  $backBtn.addEventListener('click', function () {
    hide($arena);
    hide($end);
    show($lobby);
  });

  $playAgain.addEventListener('click', function () {
    loadQuestions(function (data) { startGame(state.mode, data); });
  });

  $changeGame.addEventListener('click', function () {
    hide($end);
    show($lobby);
  });

})();
