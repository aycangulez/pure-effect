const Success = (value) => ({ type: 'Success', value });
const Failure = (error) => ({ type: 'Failure', error });
const Command = (cmd, next) => ({ type: 'Command', cmd, next });

const chain = (effect, fn) => {
    switch (effect.type) {
        case 'Success':
            return fn(effect.value);
        case 'Failure':
            return effect;
        case 'Command':
            const next = (result) => chain(effect.next(result), fn);
            return Command(effect.cmd, next);
    }
};

const effectPipe = (...fns) => {
    return (start) => fns.reduce(chain, Success(start));
};

async function runEffect(effect) {
    while (effect.type === 'Command') {
        try {
            effect = effect.next(await effect.cmd());
        } catch (e) {
            return Failure(e);
        }
    }
    return effect;
}

export { Success, Failure, Command, effectPipe, runEffect };
