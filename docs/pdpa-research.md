# What the Thai PDPA asks of *this* system — research note

**What this file is.** Research, not policy and not legal advice. It answers one question:
*which parts of the Personal Data Protection Act B.E. 2562 (พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล
พ.ศ. 2562, "PDPA") does this codebase actually trigger?* Every claim carries the source it
came from, and what could not be verified is listed as such rather than smoothed over. It
exists because `docs/roadmap.md` names PDPA as a release blocker with no shape attached,
and a blocker you cannot size is a blocker you keep deferring.

It is **not** a privacy policy and **not** a compliance claim. Deciding what this shop
promises its customers is the owner's, and that decision belongs in an ADR or a policy
document written after a lawyer has read this.

**How it was produced, and the limitation that matters.** Not by a background agent — no
subagent was available in the session that ran this, so it was done inline by one agent
reading web sources. More importantly: **the two authoritative texts could not be opened.**
The Act's Royal Gazette PDF (`ratchakitcha.soc.go.th/DATA/PDF/2562/A/069/T_0052.PDF`) and
the Information Commission copy (`oic.go.th/.../00024282.PDF`) both refused the fetch
(403 and no extractable text). So every **section number below is corroborated across two
independent secondary sources that agree with each other**, not read off the statute. The
**subordinate regulations are quoted from mirrors that reproduce the published text** and
cite the Royal Gazette as their origin; their *content* is used, but they are still mirrors.

**Before this note is acted on, the Act itself should be read.** Section numbers are the
one thing here most likely to be wrong in a way that matters.

---

## 1. The two facts that decide everything else

**Who the controller is, and therefore who owes what.** Under the Act a **data controller**
is the person or juristic person deciding why personal data is collected, used or
disclosed, and a **data processor** acts on the controller's instructions
(sources: [Siam Legal §27–29](https://library.siam-legal.com/thai-law/personal-data-protection-act-use-or-disclosure-of-personal-data-sections-27-29/),
[Mandatly](https://mandatly.com/regulations/pdpa)).

Today this system is one shop per deployment on hardware the shop controls
(ADR 0002 §1), so **the shop is the controller** and owes the whole set of duties itself.
Nothing here makes this software a processor.

That stops being true the moment ADR 0016 builds. A shop that signs up and gets "its own
space on a box we run" makes **us the processor and the shop the controller** — which adds
a written processing arrangement, our own duty to tell *them* when something goes wrong,
and (see §4) probably takes away the small-business exemption their shop was relying on.
**The hosting decision is the PDPA decision.** It is currently recorded as "deliberately
not in this roadmap", and this note is the argument for treating it as a prerequisite
rather than a later phase.

**Enforcement is no longer theoretical.** The PDPA Office (สคส., established 2022) has
issued administrative fines in five cases across eight orders totalling more than
THB 21.5 million since enforcement began ([HSF Kramer](https://www.hsfkramer.com/notes/data/2025-posts/pdpa-fines-and-firsts-a-6-year-timeline-of-thailands-data-privacy-enforcement)).
The Act's own criminal provisions are imprisonment up to one year and a fine up to one
million baht for a controller breaching specified sections
([Siam Legal §82–90](https://library.siam-legal.com/thai-law/personal-data-protection-act-administrative-liability-sections-82-90/),
[KPMG Thailand](https://assets.kpmg.com/content/dam/kpmgsites/th/pdf/legal-news-update/legal-news-flash-issue-14.pdf.coredownload.inline.pdf)),
while an expert committee may impose administrative fines of up to **THB 5 million per
contravention** ([One Asia](https://oneasia.legal/en/6627),
[Linklaters](https://www.linklaters.com/en/insights/data-protected/data-protected---thailand)).

---

## 2. The requirements, mapped to this codebase

Each row is a requirement, its home in the law, what it means here, and where this
repository actually stands. **"Met" means a mechanism exists, not that it has been
documented or rehearsed.**

| Requirement | Where | This system | State |
| --- | --- | --- | --- |
| **Privacy notice** | Required of a small business *even when exempt* from the record of processing — [announcement text](https://ecs-support.github.io/pages/knowledge/iso/law/pdpa-2565-01/) | Nothing in the repository states what a customer is told. `/shop` collects a phone number and a name to open a member account (ADR 0020), and `/display` names no one | **Missing** |
| **Record of processing activities** (ROPA) | Act §39; small-business exemption issued 20 Jun 2022 (B.E. 2565) | Sole proprietors, SMEs and household businesses are exempt. **A shop running its own till is plausibly exempt** | Probably exempt today; **at risk under ADR 0016** |
| **Security measures** | [Announcement, 20 Jun 2022 (B.E. 2565)](https://ecs-support.github.io/pages/knowledge/iso/law/pdpa-2565-01/) — organisational, technical **and** physical; risk identification, prevention, detection, response, recovery; access control by authentication, authorisation, user management, scope of responsibility and **traceability**; awareness; periodic review | Passwords hashed (bcryptjs), sessions signed (jose), a fixed deny-by-default role matrix (ADR 0022), a per-shop rate limiter (ADR 0009/0012), and a full audit trail (`audit_logs`, ADR 0022) | **Mechanisms mostly met; the document, the training and the review are not** |
| **Breach notification** | Act §40(2) + [announcement, 15 Dec 2022](https://ecs-support.github.io/pages/knowledge/iso/law/pdpa-2565-02/): notify the Office **within 72 hours** of becoming aware, unless there is no risk to rights and freedoms; notify affected individuals quickly where the risk is high | Nothing detects a breach or starts a clock. The audit log records *actions*, not intrusions | **Missing** |
| **Processor duties** | Act §40 — a processor must hold appropriate security measures **and inform the controller** of a breach | No processor exists today. Under ADR 0016 we would be one | **N/A now; a written agreement would be required** |
| **Data Protection Officer** | Act §41(2) + [announcement, 14 Sep 2023](https://ecs-support.github.io/pages/knowledge/iso/law/pdpa-2565-02/) — required where personal data is monitored regularly, or where there is a **large amount** of it | The announcement's "large amount" test begins at **100,000 data subjects** | **Not required** — one shop |
| **Data subject rights** | Act §30 access, §31 portability, §32 objection, §33 erasure, §34 restrict use, §35 accuracy | The customer portal lets a signed-in member list and download their own receipts (ADR 0021), which covers part of *access*. There is **no** erasure, portability export, objection or withdrawal route | **Partial** |
| **Cross-border transfer** | Act §28, and [announcement, 25 Dec 2023](https://ecs-support.github.io/pages/knowledge/iso/law/pdpa-2565-02/): an adequacy list, six exemptions (law, consent, contract with the data subject, a contract between controllers, vital interests, public interest), and "appropriate safeguards" | **Unresolved.** Google sign-in (ADR 0020) puts a customer's email and name into this database from a foreign service; where the database and its backups physically sit has never been stated as a compliance question | **Unresolved — see §4** |
| **Sensitive data** (ข้อมูลอ่อนไหว) | Act §26 — explicit consent; separately, a small-business exemption does *not* apply where sensitive data is processed | **None collected.** No national ID number, no health data, no bank account. This is the single largest thing the system already gets right by accident of what a POS needs | **Met** |
| **Retention and erasure** | Purpose limitation in the Act; the 2565 processor ROPA requires keeping the record three years after processing stops | There is **no purge job, no retention rule and no documented period** anywhere. `npm run backup` exists; nothing ever deletes | **Missing** |
| **Staff data** | The 2565 exemption text names customer *or employee* data explicitly | Attendance (`time_logs`), shifts (`cash_shifts`) and the audit trail reference `users` — the same table members live in | **In scope, and structurally entangled** |

---

## 3. Three findings that are not obvious from the code

**The customer display is clean, and that is worth preserving.** `/display` shows call
numbers and ticket states with no session (ADR 0018, `display-view.ts`). It is the only
customer-facing surface that holds no personal data, which is why it was drawn that way.
Any change that puts a name or a phone number on that screen turns the least protected
surface in the system into a personal-data surface.

**The signed receipt link is personal data behind a bearer token.** A walk-in's receipt
opens with no session at all (ADR 0021, `src/lib/receipt-access.ts`). That is the design,
and it is a good one — but a bearer token for personal data is only as safe as its
expiry, its single-use behaviour and whether it is logged. Nothing in the research changes
that; it is simply the place where the security-measures announcement's "traceability"
requirement and this system's own audit trail should meet.

**`users` is one table for staff and customers.** `role` defaults to `member`; a cashier
and a loyalty customer are the same row, and `orders` links both `customer_id` and
`cashier_id` to it. Two consequences a lawyer will ask about: a subject-access request
from a customer can surface staff rows through shared relations, and a subject-access
request from an *employee* pulls their purchase history at the till. Splitting the tables
is a schema decision, not a screen — the same shape ADR 0002 calls out for multi-branch —
and it should be made deliberately rather than discovered.

---

## 4. What could not be verified, and what a lawyer must be asked

- **The Act's own text was never opened.** Section numbers are corroborated across
  [Siam Legal](https://library.siam-legal.com/thai-law/personal-data-protection-act-use-or-disclosure-of-personal-data-sections-27-29/)
  and [Mandatly](https://mandatly.com/regulations/pdpa), which agree, plus the
  subordinate regulations' own citations. Treat the numbers as strong but unconfirmed.
- **Does a Google sign-in count as a transfer under §28?** The customer gives Google an
  email and name and Google returns an id token; our server verifies it against Google's
  keys. Whether that is a "sending or transferring" of personal data to a foreign country,
  and if so which of the six exemptions applies, is genuinely arguable and was not
  resolvable from sources here. **Ask a lawyer; do not assume.**
- **Where does the small-business exemption actually land for us?** If this becomes a
  hosted rental, we may be characterised as a hosting service provider or SaaS, both of
  which are named in the exemption's exclusions. That is the single highest-value question
  in this note, and it is a function of ADR 0016 rather than of the law.
- **Retention period.** Thai tax law governs how long invoices must be kept; this note did
  not establish the period from a primary source, so the rule must be written against the
  Revenue Code rather than against this file.
- **The controller/processor split under ADR 0016** turns on who decides the purposes. A
  shop choosing its own catalogue, prices and staff is a controller; a shop that cannot
  export its data or leave is closer to a consumer of a service it does not control. That
  is a design property, not only a legal one.

---

## 5. What this note does not settle

It ranks nothing. The order is the owner's to set, and it depends on whether the hosted
rental is happening — because that single decision changes the exemption, the role, and
the size of the job. What this note does is make the job measurable: of the eleven rows
above, **two are met outright, four are partially met, five are missing, and the largest
of the five (the privacy notice) is a page of Thai text rather than a piece of
architecture.**

The things a shop is told about its own customers, who may read them, and for how long are
decisions, not findings — and `CONTEXT.md` item 9 already says the written posture comes
first. This note is the input to that decision, not a substitute for it.