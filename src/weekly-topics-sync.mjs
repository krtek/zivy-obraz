import { parseArgs } from 'node:util';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Resend } from 'resend';
import { startOfUtcDay } from './utils/util.mjs';

const { values, positionals } = parseArgs({
  options: {
    'bakalari-base-url': { type: 'string' },
    'bakalari-username': { type: 'string' },
    'bakalari-password': { type: 'string' },
    'gemini-api-key': { type: 'string' },
    'resend-api-key': { type: 'string' },
    'smtp-from': { type: 'string' },
    'email-to': { type: 'string' }
  },
  allowPositionals: true
});

function resolveValue(name, index) {
  return values[name] ?? positionals[index];
}

const bakalariBaseUrl = resolveValue('bakalari-base-url', 0);
const bakalariUsername = resolveValue('bakalari-username', 1);
const bakalariPassword = resolveValue('bakalari-password', 2);
const geminiApiKey = resolveValue('gemini-api-key', 3) ?? process.env.GOOGLEAI_API_KEY;
const resendApiKey = values['resend-api-key'] ?? process.env.RESEND_API_KEY;
const smtpFrom = values['smtp-from'] ?? process.env.SMTP_FROM;
const emailTo = values['email-to'] ?? process.env.EMAIL_TO;
const emailParent = process.env.EMAIL_PARENT ?? 'mami';
const emailKid = process.env.EMAIL_KID ?? 'Sebík';

if (!bakalariBaseUrl || !bakalariUsername || !bakalariPassword) {
  throw new Error(
    'Usage: node src/weekly-topics-sync.mjs --bakalari-base-url=URL --bakalari-username=USER --bakalari-password=PASS [--gemini-api-key=KEY]'
  );
}

const baseUrl = bakalariBaseUrl.trim().replace(/\/$/, '');

function toIsoDate(date) {
  return date.toISOString().split('T')[0];
}

async function fetchAccessToken() {
  const body = new URLSearchParams({
    client_id: 'ANDR',
    grant_type: 'password',
    username: bakalariUsername,
    password: bakalariPassword
  });

  const response = await axios.post(`${baseUrl}/api/login`, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  if (!response.data?.access_token) {
    throw new Error('Bakaláři login did not return an access token.');
  }

  return response.data.access_token;
}

async function fetchWeeklyTopics() {
  const now = new Date();
  const today = startOfUtcDay(now);
  const weekAgo = new Date(today);
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);

  const token = await fetchAccessToken();

  const [timetableResponse, subjectsResponse] = await Promise.all([
    axios.get(`${baseUrl}/api/3/timetable/actual`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { date: toIsoDate(today) }
    }),
    axios.get(`${baseUrl}/api/3/subjects`, {
      headers: { Authorization: `Bearer ${token}` }
    })
  ]);

  const rawSubjects = subjectsResponse.data?.Subjects ?? subjectsResponse.data?.subjects ?? [];
  const subjectsById = Object.fromEntries(
    rawSubjects
      .map(s => [s?.SubjectID ?? s?.SubjectId ?? s?.Id ?? s?.id, s])
      .filter(([id]) => typeof id === 'string' && id.trim())
      .map(([id, s]) => [id.trim(), s])
  );

  function resolveSubjectName(subjectId) {
    const id = typeof subjectId === 'string' ? subjectId.trim() : String(subjectId ?? '').trim();
    const s = subjectsById[id];
    return s?.SubjectAbbrev ?? s?.SubjectName ?? id;
  }

  const days = timetableResponse.data?.Days ?? timetableResponse.data?.days ?? [];

  // Collect entries: { date, subjectName, topic }
  const seen = new Set();
  const entries = [];

  for (const day of days) {
    const raw = day?.Date ?? day?.DayDate ?? day?.date ?? day?.dayDate;
    if (!raw) continue;

    const dateStr = typeof raw === 'string' ? raw.slice(0, 10) : toIsoDate(new Date(raw));
    const dayDate = new Date(dateStr + 'T00:00:00Z');

    // Filter to past 7 days (weekAgo <= dayDate <= today)
    if (dayDate < weekAgo || dayDate > today) continue;

    const atoms = day?.Atoms ?? day?.Lessons ?? day?.atoms ?? day?.lessons ?? [];

    for (const atom of atoms) {
      const theme = (atom?.Theme ?? atom?.theme ?? '').trim();
      if (!theme) continue;

      const subjectId = atom?.SubjectId ?? atom?.subjectId ?? '';
      const subjectName = resolveSubjectName(subjectId);

      const key = `${dateStr}|${subjectName}|${theme}`;
      if (seen.has(key)) continue;
      seen.add(key);

      entries.push({ date: dateStr, subjectName, topic: theme });
    }
  }

  // Group by subject, topics sorted by date
  const bySubject = new Map();
  for (const { date, subjectName, topic } of entries) {
    if (!bySubject.has(subjectName)) bySubject.set(subjectName, []);
    bySubject.get(subjectName).push({ date, topic });
  }

  // Sort subjects alphabetically, topics by date within each subject
  const result = [...bySubject.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'cs'))
    .map(([subjectName, topics]) => ({
      subjectName,
      topics: topics.sort((a, b) => a.date.localeCompare(b.date))
    }));

  return result;
}

fetchWeeklyTopics()
  .then(async result => {
    if (!geminiApiKey) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `Níže jsou témata probíraná ve škole za uplynulý týden, seřazená podle předmětu. Napiš stručný a čtivý přehled v češtině pro maminku ${emailParent} – buď familiérní, začni neformálním pozdravem. Jméno ${emailParent} správně skloňuj do 5. pádu (vokativu), např. „Pájo" pro „Pája", „Luciie" pro „Lucie" atd.

Struktura výstupu:
1. Nejprve uveď předměty Čeština (Cj) a Matematika (M) jako první dvě položky v seznamu, poté ostatní předměty abecedně.
2. Za seznamem předmětů přidej sekci nadepsanou „<b>Procvičovací otázky</b>" s 5 otázkami z Češtiny, 5 z Matematiky a 5 z Fyziky — celkem 15 otázek. Otázky musí být VÝHRADNĚ z těchto tří předmětů — žádné otázky z jiných předmětů. Otázky formuluj přímo a konkrétně — neptej se „Můžeš mi vysvětlit..." ani „Vzpomeneš si...". Místo toho zadej přímo úkol, např. „Rozšiř zlomek 1/4 na šestiny." nebo „Dopiš správný spojovací výraz: Přišel jsem pozdě, ___ jsem zaspal."

Výstup musí být validní HTML fragment (bez <html>/<head>/<body> tagů) vhodný pro vložení do e-mailu. Nepoužívej žádný markdown — pouze HTML tagy.

Drž se PŘESNĚ této šablony — žádné vnořené seznamy, žádné odchylky:

<p>Ahoj [${emailParent} ve vokativu]! [jedna věta úvodu]</p>
<ul>
  <li><b>Čeština:</b> [shrnutí témat, oddělená čárkami]</li>
  <li><b>Matematika:</b> [shrnutí témat, oddělená čárkami]</li>
  <li><b>[Další předmět]:</b> [shrnutí témat]</li>
</ul>
<p><b>Procvičovací otázky</b></p>
<p><b>Čeština:</b></p>
<ul>
  <li>[konkrétní úkol]</li>
  <li>[konkrétní úkol]</li>
  <li>[konkrétní úkol]</li>
  <li>[konkrétní úkol]</li>
  <li>[konkrétní úkol]</li>
</ul>
<p><b>Matematika:</b></p>
<ul>
  <li>[konkrétní úkol]</li>
  <li>[konkrétní úkol]</li>
  <li>[konkrétní úkol]</li>
  <li>[konkrétní úkol]</li>
  <li>[konkrétní úkol]</li>
</ul>
<p><b>Fyzika:</b></p>
<ul>
  <li>[konkrétní úkol]</li>
  <li>[konkrétní úkol]</li>
  <li>[konkrétní úkol]</li>
  <li>[konkrétní úkol]</li>
  <li>[konkrétní úkol]</li>
</ul>

Data:
${JSON.stringify(result, null, 2)}`;

    const response = await model.generateContent(prompt);
    const summary = response.response.text();

    console.log(summary);

    if (!resendApiKey || !emailTo) {
      console.error('Resend API key or EMAIL_TO not set — skipping email.');
      return;
    }

    const resend = new Resend(resendApiKey);
    const now = new Date();
    const weekLabel = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' }).format(now);

    const { error } = await resend.emails.send({
      from: smtpFrom ?? `Sebíkův školní přehled <noreply@krtinec.cz>`,
      to: emailTo,
      subject: `Co probíral ${emailKid} ve škole — týden do ${weekLabel}`,
      html: summary
    });

    if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);

    console.error(`Email sent to ${emailTo}`);
  })
  .catch(err => {
    console.error('Error:', err.message ?? err);
    process.exit(1);
  });
