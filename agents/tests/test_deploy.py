"""The public demo's settings, checked before they reach Fly.

On 2026-11-13 the agents' default moved to qwen3.5:9b on a local Ollama, and fly.toml
named no model, so the deployed agents waited on a model server the machine doesn't
have and no visitor got an answer. Every unit test passed, as they run with
MODEL_BASE_URL=off. These read fly.toml and start.sh themselves.
"""

import os
import re
import tomllib
import unittest
from pathlib import Path
from unittest import mock

import core
import openai_compat
import prices

ROOT = Path(__file__).resolve().parents[2]


class DeployTest(unittest.TestCase):
    def setUp(self):
        self.env = {key: str(value) for key, value in tomllib.loads((ROOT / "fly.toml").read_text())["env"].items()}
        self.start = (ROOT / "services/api/start.sh").read_text()

    def test_fly_runs_no_model_server_so_none_is_expected(self):
        self.assertNotIn("ollama", self.start.lower())
        self.assertEqual(self.env.get("MODEL_BASE_URL"), "off", "fly.toml must set MODEL_BASE_URL=off: the machine has no model server")

    def test_every_model_on_fly_is_gemini_and_priced(self):
        for name in ("LEAD_MODEL", "SPECIALIST_MODEL"):
            model = self.env.get(name, "")
            self.assertTrue(openai_compat.is_gemini(model), f"{name} in fly.toml must be a Gemini model, not {model!r}")
            # Unpriced, a model's calls would cost nothing to the visitors' daily budget.
            self.assertIsNotNone(prices.cost(model, 1_000, 100), f"{model} has no price in prices.py")

    def test_the_agents_read_these_settings_as_gemini(self):
        names = ("LEAD_MODEL", "SPECIALIST_MODEL", "MODEL_BASE_URL")
        with mock.patch.dict(os.environ, {**{name: "" for name in names}, **self.env}):
            settings = core.config()
        self.assertTrue(openai_compat.is_gemini(settings.lead_model))
        self.assertTrue(openai_compat.is_gemini(settings.specialist_model))

    def test_settings_offers_only_models_fly_can_run(self):
        choices = self.env.get("MODEL_CHOICES", "").split(",")
        self.assertEqual(choices[0], self.env.get("LEAD_MODEL"), "the first of MODEL_CHOICES is the default, LEAD_MODEL")
        for model in choices:
            self.assertTrue(openai_compat.is_gemini(model), f"MODEL_CHOICES on Fly must be Gemini models, not {model!r}")
            self.assertIsNotNone(prices.cost(model, 1_000, 100), f"{model} has no price in prices.py")

    def test_the_services_default_choices_are_the_agents_defaults(self):
        main = (ROOT / "services/api/src/main.ts").read_text()
        default = re.search(r'DEFAULT_MODEL_CHOICES = "([^"]+)"', main)
        self.assertIsNotNone(default)
        self.assertEqual(default.group(1).split(","), [core.DEFAULT_MODEL, core.FALLBACK_MODEL])

    def test_the_chat_and_media_agents_start_with_the_service(self):
        self.assertIn("for agent in main media", self.start)
        self.assertIn('/opt/agents/bin/python "agents/$agent.py" listen', self.start)


if __name__ == "__main__":
    unittest.main()
