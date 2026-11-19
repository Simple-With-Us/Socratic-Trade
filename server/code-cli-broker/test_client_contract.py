"""Offline current-client contract checks, not installed CLI/model qualification."""
import json
import pathlib
import unittest
from unittest.mock import patch
import adapters
import exec_adapters as native
from broker import Broker, Denied, validate
from test_broker import request


class ClientContractTests(unittest.TestCase):
    def test_effort_ladder_reaches_runner_exactly(self):
        seen = []
        broker = Broker('owner', 'fixture', {'minimax': ['m1']},
                        lambda data: seen.append(data.copy()) or dict(version=1, text='ok', finishReason='stop'))
        for effort in ('minimal', 'low', 'medium', 'high', 'xhigh', 'max'):
            data = request()
            data['reasoningEffort'] = effort
            broker.generate('Bearer fixture', data)
            self.assertEqual(seen[-1]['reasoningEffort'], effort)

    def test_bad_effort_types_and_values_refuse_before_runner(self):
        with patch.object(native.subprocess, 'Popen') as spawn:
            for value in [None, True, 1, [], {}, '', 'none', 'HIGH', 'max;echo']:
                data = request()
                data['reasoningEffort'] = value
                with self.assertRaises(Denied):
                    validate(data, 'owner', {'minimax': ['m1']})
            spawn.assert_not_called()

    def test_contributor_max_refused_without_clamping(self):
        data = request()
        data.update(adapter='muse', model=native.MUSE_MODEL, reasoningEffort='max')
        with self.assertRaises(Denied):
            validate(data, 'owner', {'muse': [native.MUSE_MODEL]})
        with self.assertRaises(Denied):
            native.cli_arguments('muse', native.MUSE_MODEL, 'max')

    def test_absent_effort_does_not_invent_override(self):
        data = request()
        for module in (adapters, native):
            self.assertNotIn('reasoningEffort', json.loads(module.prompt_text(data)))
        self.assertNotIn('--effort', native.cli_arguments('minimax', native.MINIMAX_MODEL))

    def test_effort_is_preserved_in_staged_payload_and_cli_args(self):
        data = request()
        data['reasoningEffort'] = 'high'
        for module in (adapters, native):
            self.assertEqual(json.loads(module.prompt_text(data))['reasoningEffort'], 'high')
        for adapter, model, flag in [('minimax', native.MINIMAX_MODEL, '--effort'),
                                      ('muse', native.MUSE_MODEL, '--reasoning-effort')]:
            args = native.cli_arguments(adapter, model, 'high')
            self.assertEqual(args[args.index(flag)+1], 'high')

    def test_unqualified_protocol_effort_cannot_be_silently_ignored(self):
        data = request()
        data['reasoningEffort'] = 'high'
        for run in (adapters.minimax, adapters.muse):
            with patch.object(adapters, 'Rpc') as spawn:
                with self.assertRaisesRegex(Denied, 'effort setting not qualified'):
                    run(data, ['not-a-launcher'])
                spawn.assert_not_called()

    def test_current_catalog_models_are_exact_and_tier_explicit(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        catalog = (root/'src/lib/llm-model-catalog.ts').read_text()
        for model in [native.MINIMAX_MODEL, *native.MUSE_MODELS]:
            self.assertIn('nativeSlug: "'+model+'"', catalog)
            adapter = 'minimax' if model == native.MINIMAX_MODEL else 'muse'
            data = request()
            data.update(adapter=adapter, model=model)
            self.assertEqual(validate(data, 'owner', {adapter: [model]})['model'], model)
            args = native.cli_arguments(adapter, model)
            self.assertEqual(args[args.index('--model')+1], 'minimax/'+model if adapter == 'minimax' else model)
            if adapter == 'muse':
                self.assertEqual(args[args.index('--contributor-mode')+1], 'on')

    def test_retired_aliases_not_silently_mapped(self):
        for adapter, model in [('minimax', 'MiniMax-M3.1-Flash-Preview'), ('muse', 'muse-spark-1.3'),
                               ('muse', 'muse-wonder-1.0'), ('minimax', 'MiniMax-M3')]:
            with self.assertRaises(Denied):
                native.cli_arguments(adapter, model)


if __name__ == '__main__':
    unittest.main()
