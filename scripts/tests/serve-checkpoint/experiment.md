# Serve a checkpoint

Train a tiny causal LM, then **serve** it: load `artifacts/checkpoints/last.json`, encode the prompt with the pinned tokenizer, generate tokens, write `artifacts/serve.json`. Not HTTP. Same train dir as fit and eval.

Do not invent output. Run `aq serve`.
