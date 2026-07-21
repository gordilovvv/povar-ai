# itty-router

Роутер для HTTP-хендлеров sema (см. `src/index.ts`). Возвращаем ответы через
хелпер `status()`, а не `new Response`.

## Запуск на Node.js

Node не умеет в Web-стандартный `fetch`-handler из коробки — оборачиваем роутер
адаптером `@whatwg-node/server`.

```ts
import { createServerAdapter } from '@whatwg-node/server';
import { createServer } from 'http';
import { AutoRouter } from 'itty-router';

const router = AutoRouter();

router.get('/', () => ({ message: 'Hello, from itty-router v5.' }));

const ittyServer = createServerAdapter(router.fetch);
const httpServer = createServer(ittyServer);
httpServer.listen(3001);
```

### Ручной вызов (опционально)

Любой роутер можно дёрнуть напрямую — передаём `Request` (и любые доп. аргументы)
в `.fetch()`. Все совпавшие хендлеры/middleware получат эти аргументы.

```ts
const request = new Request('https://foo.bar');
const response = await router.fetch(request);
```

## Три роутера

Все три дают эквивалентный API; разница — в наборе встроенных стадий и размере.

- **`AutoRouter`** — батарейки включены: `withParams`, JSON-форматирование ответа,
  обработка ошибок и 404 уже встроены. ~1kB. Наш дефолт.
- **`Router`** — добавляет стадии `before`, `catch`, `finally` для ручного
  контроля ответов и ошибок.
- **`IttyRouter`** — минимальный и самый быстрый: никаких лишних стадий,
  форматирование/ошибки разруливаются через цепочку промисов `router.fetch()`.

```ts
// AutoRouter — самодостаточен
import { AutoRouter } from 'itty-router';

const router = AutoRouter();

router
    .get('/hello/:name', ({ name }) => `Hello, ${name}!`)
    .get('/json', () => ({ foo: 'bar' }))
    .get('/throw', (a) => a.b.c); // безопасно бросит ошибку

export default { ...router };
```

## Производительность

Все современные роутеры быстрые: 100k ops/sec ≈ +0.01ms на запрос. На холодный
старт и латентность в serverless сильнее влияет **размер бандла** — ради этого
itty и существует.

### Базовые правила

1. **Критичные пути регистрируем первыми** — они матчатся и выходят из роутера
   раньше остальных.
2. **Вкладывайте API (nesting)** — вложенность отсекает целые ветки маршрутов от
   сравнения; делите роутер на части, балансируя читаемость и скорость.
3. **Выходите как можно раньше** — каждый матч это оверхед для текущего и
   параллельных запросов. При вложенности добавляйте `404` в дочерний роутер:
   иначе промах в нём выходит наверх и продолжает перебирать маршруты родителя до
   финального `404`.

### Ultra-tuning (если нужно выжать максимум)

- Не использовать `withParams` — Proxy-слой над `Request` чуть тормозит.
- Не использовать `AutoRouter` — он включает `withParams`.
- Не использовать `Router` — стадии `before`/`catch`/`finally` добавляют расходы.
- Использовать `IttyRouter` — самый маленький и за счёт этого самый быстрый.
