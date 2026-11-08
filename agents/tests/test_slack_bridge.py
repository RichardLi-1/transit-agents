"""The Slack bridge: which study a question goes to, refusing decisions, finding the
lead's answer in the log, and the reply's form. No real Slack, and no service."""

import unittest
from typing import Any

import httpx

import slack_bridge as bridge
from slack_bridge import DEFAULT_STUDY, Bridge, answer_in, clip, mrkdwn, parse, reply, wanted

ONTARIO = "ontario-line-don-mills"
KNOWN = [ONTARIO, "lawrence-sunnybrook", "sherbourne-castle-frank", "eglinton-east"]


def entry(seq: int, actor: str, kind: str, text: str | None = None, study: str = ONTARIO, audience: str | None = None) -> dict[str, Any]:
    data: dict[str, Any] = {"kind": kind}
    if text is not None:
        data["text"] = text
    return {"seq": seq, "type": "activity", "actor": actor, "studyId": study, "data": data, "audience": audience}


class Parse(unittest.TestCase):
    def test_the_ontario_line_by_default(self):
        request = parse("<@U07BOT> what would the Don Mills extension cost?", KNOWN)
        self.assertEqual(request.study, DEFAULT_STUDY)
        self.assertEqual(DEFAULT_STUDY, ONTARIO)
        self.assertEqual(request.text, "what would the Don Mills extension cost?")
        self.assertFalse(request.deciding)

    def test_a_short_name_picks_the_study(self):
        self.assertEqual(parse("<@U07BOT> ontario: who needs to hear about this?").study, ONTARIO)
        self.assertEqual(parse("<@U07BOT> ontario: who needs to hear about this?").text, "who needs to hear about this?")
        self.assertEqual(parse("<@U07BOT|transit> Lawrence: riders?").study, "lawrence-sunnybrook")
        self.assertEqual(parse("sherbourne : how long is the walk?").study, "sherbourne-castle-frank")

    def test_a_study_id_picks_the_study_when_known(self):
        request = parse("<@U07BOT> eglinton-east: what's open?", KNOWN)
        self.assertEqual((request.study, request.text), ("eglinton-east", "what's open?"))
        # Not a study: the words stay as they are, for the Ontario Line.
        request = parse("<@U07BOT> Note: the bridge is closed. What changes?", KNOWN)
        self.assertEqual((request.study, request.text), (ONTARIO, "Note: the bridge is closed. What changes?"))

    def test_only_a_mention_is_no_question(self):
        self.assertEqual(parse("<@U07BOT>").text, "")
        self.assertEqual(parse("<@U07BOT> lawrence:").text, "")

    def test_asking_to_decide_is_refused(self):
        for text in (
            "adopt option B",
            "Please approve the Don Mills alignment",
            "ontario: can you decide between the termini?",
            "let's go with the tunnel",
            "Let’s pick option A",
            "record the decision for option B",
            "We'll adopt the east option",
            "make a decision on the crossing",
            "Decision: tunnel",
        ):
            with self.subTest(text=text):
                self.assertTrue(parse(f"<@U07BOT> {text}", KNOWN).deciding)

    def test_asking_about_a_decision_is_answered(self):
        for text in (
            "what would the Don Mills extension cost?",
            "who needs to hear about this?",
            "should we adopt option B?",
            "what decisions are still open?",
            "how did planners decide on the last study?",
        ):
            with self.subTest(text=text):
                self.assertFalse(parse(f"<@U07BOT> {text}", KNOWN).deciding)


class AnswerIn(unittest.TestCase):
    def test_the_last_message_of_the_run_after_the_question(self):
        entries = [
            entry(11, "agent:lead", "run.started"),
            entry(12, "agent:lead", "usage"),
            entry(13, "agent:lead", "message", "It would cost $1.2B."),
            entry(14, "agent:lead", "run.finished"),
        ]
        self.assertIsNone(answer_in(entries[:3], ONTARIO, 10))
        self.assertEqual(answer_in(entries, ONTARIO, 10), "It would cost $1.2B.")

    def test_a_run_already_going_answers_an_earlier_question(self):
        entries = [
            entry(11, "agent:lead", "message", "The answer to the display's question."),
            entry(12, "agent:lead", "run.finished"),
            entry(13, "agent:lead", "run.started"),
            entry(14, "agent:lead", "message", "The answer to Slack's."),
            entry(15, "agent:lead", "run.finished"),
        ]
        self.assertIsNone(answer_in(entries[:2], ONTARIO, 10))
        self.assertEqual(answer_in(entries, ONTARIO, 10), "The answer to Slack's.")

    def test_other_studies_sandboxes_and_agents_dont_count(self):
        entries = [
            entry(11, "agent:lead", "run.started", study="lawrence-sunnybrook"),
            entry(12, "agent:lead", "message", "Lawrence.", study="lawrence-sunnybrook"),
            entry(13, "agent:lead", "run.started", audience="guest:abc"),
            entry(14, "agent:replay", "run.started"),
            entry(15, "agent:replay", "message", "Scripted."),
            entry(16, "agent:media", "message", "An image."),
            entry(17, "planner:local", "message", "Another question"),
            entry(18, "agent:replay", "run.finished"),
        ]
        self.assertIsNone(answer_in(entries, ONTARIO, 10))
        self.assertIsNone(answer_in([entry(9, "agent:lead", "run.started"), entry(10, "agent:lead", "run.finished")], ONTARIO, 10))

    def test_a_run_without_a_message_is_an_empty_answer(self):
        self.assertEqual(answer_in([entry(11, "agent:lead", "run.started"), entry(12, "agent:lead", "run.finished")], ONTARIO, 10), "")

    def test_the_lead_past_its_limits_answers_without_a_run(self):
        busy = "The agent has answered as many messages as it may this hour. Try again later."
        self.assertEqual(answer_in([entry(11, "agent:lead", "message", busy)], ONTARIO, 10), busy)


class Form(unittest.TestCase):
    def test_mrkdwn(self):
        self.assertEqual(mrkdwn("Costs <$2B> & more"), "Costs &lt;$2B&gt; &amp; more")
        self.assertEqual(mrkdwn("See [the plan](https://example.org/a?b=1)"), "See <https://example.org/a?b=1|the plan>")
        self.assertEqual(mrkdwn("**Cost**\n- one\n- two\n## Riders"), "*Cost*\n• one\n• two\n*Riders*")

    def test_clip(self):
        self.assertEqual(clip("short"), "short")
        long = "word " * 1000
        clipped = clip(long)
        self.assertLessEqual(len(clipped), bridge.SLACK_LIMIT)
        self.assertTrue(clipped.endswith("word…"))
        # Never half an escape, or half a link.
        self.assertEqual(clip("x" * 15 + "&amp;", 18), "x" * 15 + "…")
        self.assertEqual(clip("x" * 12 + "<https://a.b|c>", 20), "x" * 12 + "…")

    def test_reply(self):
        text = reply("- It would cost $1.2B, plan p. 3", "https://transit-agents.fly.dev/", ONTARIO)
        self.assertEqual(text, "• It would cost $1.2B, plan p. 3\n\n<https://transit-agents.fly.dev/#ontario-line-don-mills|Open the study>")
        self.assertIn("without an answer", reply("  ", "http://127.0.0.1:4580", ONTARIO))
        long = reply("a " * 3000, "http://127.0.0.1:4580", ONTARIO)
        self.assertLess(len(long), bridge.SLACK_LIMIT + 100)
        self.assertTrue(long.endswith("|Open the study>"))

    def test_only_peoples_new_direct_messages(self):
        self.assertTrue(wanted({"channel_type": "im", "text": "hi"}))
        self.assertFalse(wanted({"channel_type": "channel", "text": "hi"}))
        self.assertFalse(wanted({"channel_type": "im", "subtype": "message_changed"}))
        self.assertFalse(wanted({"channel_type": "im", "bot_id": "B1", "text": "hi"}))


class FakeService:
    def __init__(self, pages: list[list[dict[str, Any]]], fail: bool = False, executive: str | None = "Jordan Lee"):
        self.pages, self.fail, self.name = pages, fail, executive
        self.asked: list[tuple[str, str, str]] = []
        self.escalated: list[tuple[str, str, int | None]] = []

    def executive(self) -> str | None:
        return self.name

    def escalate(self, study: str, text: str, message: int | None) -> tuple[bool, str]:
        if self.escalated:
            return False, f"{self.name} was pinged about this just now."
        self.escalated.append((study, text, message))
        return True, self.name or ""

    def studies(self) -> dict[str, str]:
        if self.fail:
            raise httpx.ConnectError("down")
        return {study: study for study in KNOWN}

    def ask(self, study: str, text: str, key: str) -> int:
        self.asked.append((study, text, key))
        return 10

    def log(self, after: int) -> list[dict[str, Any]]:
        return [e for e in (self.pages.pop(0) if self.pages else []) if e["seq"] > after]

    def media(self, sha: str) -> bytes:
        return b"%PDF-1.3 " + sha.encode()


class FakeSlack:
    def __init__(self):
        self.posts: list[dict[str, Any]] = []
        self.updates: list[dict[str, Any]] = []

    def chat_postMessage(self, **kwargs: Any) -> dict[str, Any]:
        self.posts.append(kwargs)
        return {"ts": f"9.{len(self.posts)}"}

    def chat_update(self, **kwargs: Any) -> dict[str, Any]:
        self.updates.append(kwargs)
        return {"ok": True}

    files: list[dict[str, Any]]
    refuse_files = False

    def files_upload_v2(self, **kwargs: Any) -> dict[str, Any]:
        if self.refuse_files:
            raise RuntimeError("missing_scope")
        self.files = [*getattr(self, "files", []), kwargs]
        return {"ok": True}


def make_bridge(service: FakeService) -> Bridge:
    """A bridge on a fake clock, whose waits take no time."""
    now = [0.0]

    def sleep(seconds: float) -> None:
        now[0] += seconds

    return Bridge(service, "http://127.0.0.1:4580", wait_seconds=240, poll_seconds=2, sleep=sleep, clock=lambda: now[0])  # type: ignore[arg-type]


class Handle(unittest.TestCase):
    def bridge(self, service: FakeService) -> Bridge:
        return make_bridge(service)

    def test_asks_then_updates_working_with_the_answer(self):
        lawrence = "lawrence-sunnybrook"
        service = FakeService(
            [
                [],
                [entry(11, "agent:lead", "run.started", study=lawrence)],
                [entry(12, "agent:lead", "message", "**$1.2B**", study=lawrence), entry(13, "agent:lead", "run.finished", study=lawrence)],
            ]
        )
        slack = FakeSlack()
        event = {"channel": "C1", "ts": "1.5", "text": "<@U07BOT> lawrence: what would it cost?", "user": "U1"}
        self.bridge(service).handle(event, slack)
        self.assertEqual(service.asked, [("lawrence-sunnybrook", "what would it cost?", "slack:C1:1.5")])
        self.assertEqual(slack.posts, [{"channel": "C1", "thread_ts": "1.5", "text": "Working on it…", "unfurl_links": False}])
        self.assertEqual(slack.updates, [{"channel": "C1", "ts": "9.1", "text": "*$1.2B*\n\n<http://127.0.0.1:4580/#lawrence-sunnybrook|Open the study>"}])

    def test_the_same_event_twice_is_answered_once(self):
        service = FakeService([[entry(11, "agent:lead", "run.started"), entry(12, "agent:lead", "run.finished")]])
        slack, handler = FakeSlack(), self.bridge(service)
        event = {"channel": "C1", "ts": "1.5", "thread_ts": "1.0", "text": "<@U07BOT> cost?"}
        handler.handle(event, slack)
        handler.handle(event, slack)
        self.assertEqual(len(service.asked), 1)
        self.assertEqual(slack.posts[0]["thread_ts"], "1.0")

    def test_times_out_politely(self):
        slack = FakeSlack()
        self.bridge(FakeService([])).handle({"channel": "C1", "ts": "1.5", "text": "<@U07BOT> cost?"}, slack)
        self.assertIn("hasn't answered after 4 minutes", slack.updates[0]["text"])
        self.assertIn("|Open the study>", slack.updates[0]["text"])

    def test_decisions_are_refused_without_asking(self):
        service, slack = FakeService([]), FakeSlack()
        self.bridge(service).handle({"channel": "C1", "ts": "1.5", "text": "<@U07BOT> ontario: adopt option B"}, slack)
        self.assertEqual(service.asked, [])
        self.assertEqual(len(slack.posts), 1)
        self.assertIn("Only a signed-in planner can record a decision", slack.posts[0]["text"])
        self.assertIn("<http://127.0.0.1:4580/#ontario-line-don-mills|Open the study>", slack.posts[0]["text"])

    def test_no_question_or_no_service(self):
        slack = FakeSlack()
        self.bridge(FakeService([])).handle({"channel": "C1", "ts": "1.5", "text": "<@U07BOT>"}, slack)
        self.bridge(FakeService([], fail=True)).handle({"channel": "C1", "ts": "1.6", "text": "<@U07BOT> cost?"}, slack)
        self.assertEqual([post["text"] for post in slack.posts], [bridge.NO_QUESTION, bridge.FAILED])


    def document_run(self) -> FakeService:
        text = f"Document ready: TPAP brief: Ontario Line Don Mills extension. http://127.0.0.1:4100/v1/media/{SHA}"
        return FakeService([[entry(11, "agent:lead", "run.started"), entry(12, "agent:lead", "message", text), entry(13, "agent:lead", "run.finished")]])

    def test_a_document_is_attached_in_the_thread(self):
        slack = FakeSlack()
        self.bridge(self.document_run()).handle({"channel": "C1", "ts": "1.5", "text": "<@U07BOT> make a TPAP brief as a PDF"}, slack)
        self.assertIn(f"/v1/media/{SHA}", slack.updates[0]["text"])
        [upload] = slack.files
        self.assertEqual(upload["channel"], "C1")
        self.assertEqual(upload["thread_ts"], "1.5")
        self.assertEqual(upload["filename"], "tpap-brief-ontario-line-don-mills-extension.pdf")
        self.assertEqual(upload["title"], "TPAP brief: Ontario Line Don Mills extension")
        self.assertTrue(upload["content"].startswith(b"%PDF"))

    def test_without_the_files_scope_the_link_stays(self):
        slack = FakeSlack()
        slack.refuse_files = True
        self.bridge(self.document_run()).handle({"channel": "C1", "ts": "1.5", "text": "<@U07BOT> make a TPAP brief as a PDF"}, slack)
        self.assertIn(f"/v1/media/{SHA}", slack.updates[0]["text"])
        self.assertFalse(hasattr(slack, "files"))

    def test_an_answer_without_a_document_attaches_nothing(self):
        self.assertIsNone(bridge.document_in("The cost is $4.6B (ontario-line-ibc-2019 p. 77)."))


SHA = "08f81de7bb5bc84819ba01532be976ab385b8389ef4dc3a27200cc6c86f67fe0"


class Executive(unittest.TestCase):
    ANSWER = "Option A is longer (ibc p. 14).\n\nExecutive decision required: which alignment option to fund."

    def answered(self, executive: str | None = "Jordan Lee") -> tuple[FakeService, FakeSlack, Bridge]:
        service = FakeService(
            [[entry(11, "agent:lead", "run.started"), entry(12, "agent:lead", "message", self.ANSWER), entry(13, "agent:lead", "run.finished")]],
            executive=executive,
        )
        slack, handler = FakeSlack(), make_bridge(service)
        handler.handle({"channel": "C1", "ts": "1.5", "text": "<@U07BOT> which alignment should we fund?"}, slack)
        return service, slack, handler

    def test_an_answer_that_needs_an_executive_says_who_to_ping_and_how(self):
        _, slack, _ = self.answered()
        self.assertTrue(
            slack.updates[0]["text"].endswith(
                "|Open the study>\n\n*Executive decision required.* Ask a planner to ping Jordan Lee from the study, or reply `ping` here."
            )
        )

    def test_ping_in_its_thread_pings_the_executive_once(self):
        service, slack, handler = self.answered()
        handler.handle({"channel": "C1", "ts": "1.7", "thread_ts": "1.5", "text": "<@U07BOT> ping"}, slack)
        self.assertEqual(service.escalated, [(ONTARIO, "Which alignment option to fund.", 12)])
        self.assertEqual(slack.posts[-1]["text"], "Pinged Jordan Lee on Slack.\n\n<http://127.0.0.1:4580/#ontario-line-don-mills|Open the study>")
        self.assertEqual(slack.posts[-1]["thread_ts"], "1.5")
        # A second ping is the service's to refuse, in its words.
        handler.handle({"channel": "C1", "ts": "1.8", "thread_ts": "1.5", "text": "ping"}, slack)
        self.assertEqual(slack.posts[-1]["text"], "Jordan Lee was pinged about this just now.")
        self.assertEqual(len(service.asked), 1)

    def test_ping_elsewhere_asks_nothing(self):
        service, slack, handler = self.answered()
        handler.handle({"channel": "C1", "ts": "2.1", "thread_ts": "2.0", "text": "<@U07BOT> ping"}, slack)
        self.assertEqual(slack.posts[-1]["text"], bridge.NOTHING_TO_PING)
        self.assertEqual(service.escalated, [])
        self.assertEqual(len(service.asked), 1)

    def test_without_slack_set_up_no_offer(self):
        _, slack, _ = self.answered(executive=None)
        self.assertNotIn("reply `ping`", slack.updates[0]["text"])

    def test_the_decision_on_the_last_executive_line(self):
        self.assertEqual(bridge.executive_decision(self.ANSWER), "Which alignment option to fund.")
        self.assertIsNone(bridge.executive_decision("For a planner to decide: adopt?"))


if __name__ == "__main__":
    unittest.main()
