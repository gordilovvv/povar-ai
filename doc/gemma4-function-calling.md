# Function Calling with Gemma 4

Источник: Google Gemma Cookbook (Hugging Face ecosystem)

> Важно: Gemma не выполняет код сама. Ты парсишь её output и запускаешь функцию сам.

---

## Загрузка модели

```python
from transformers import AutoProcessor, AutoModelForMultimodalLM

MODEL_ID = "google/gemma-4-E2B-it"  # или E4B, 12B, 31B, 26B-A4B

model = AutoModelForMultimodalLM.from_pretrained(MODEL_ID, dtype="auto", device_map="auto")
processor = AutoProcessor.from_pretrained(MODEL_ID)
```

---

## Передача инструментов

Два способа определить инструмент:

### 1. JSON Schema (вручную)

```python
weather_function_schema = {
    "type": "function",
    "function": {
        "name": "get_current_temperature",
        "description": "Gets the current temperature for a given location.",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "The city name, e.g. San Francisco",
                },
            },
            "required": ["location"],
        },
    }
}

text = processor.apply_chat_template(message, tools=[weather_function_schema], tokenize=False, add_generation_prompt=True)
```

### 2. Raw Python function (автоматическая генерация схемы)

```python
from transformers.utils import get_json_schema

def get_current_temperature(location: str):
    """
    Gets the current temperature for a given location.

    Args:
        location: The city name, e.g. San Francisco
    """
    return "15°C"

text = processor.apply_chat_template(message, tools=[get_json_schema(get_current_temperature)], ...)
```

> Caveat: автоконвертер не раскрывает вложенные объекты (custom classes). Для сложных параметров — писать JSON schema вручную.

---

## Полный цикл function calling

### 1. Model's Turn — генерация вызова

```python
def get_current_weather(location: str, unit: str = "celsius"):
    """
    Gets the current weather in a given location.

    Args:
        location: The city and state, e.g. "San Francisco, CA" or "Tokyo, JP"
        unit: The unit to return the temperature in. (choices: ["celsius", "fahrenheit"])
    """
    return {"temperature": 15, "weather": "sunny"}

message = [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hey, what's the weather in Tokyo right now?"},
]

text = processor.apply_chat_template(message, tools=[get_current_weather], tokenize=False, add_generation_prompt=True)
inputs = processor(text=text, return_tensors="pt").to(model.device)
out = model.generate(**inputs, max_new_tokens=128)
generated_tokens = out[0][len(inputs["input_ids"][0]):]
output = processor.decode(generated_tokens, skip_special_tokens=False)
# Output: <|tool_call>call:get_current_weather{location:<|"|>Tokyo, JP<|"|>}<tool_call|>
```

### 2. Developer's Turn — парсинг и выполнение

```python
import re

def extract_tool_calls(text):
    def cast(v):
        try: return int(v)
        except:
            try: return float(v)
            except: return {'true': True, 'false': False}.get(v.lower(), v.strip("'\""))

    return [{
        "name": name,
        "arguments": {
            k: cast((v1 or v2).strip())
            for k, v1, v2 in re.findall(r'(\w+):(?:<\|"\|>(.*?)<\|"\|>|([^,}]*))', args)
        }
    } for name, args in re.findall(r"<\|tool_call>call:(\w+)\{(.*?)\}<tool_call\|>", text, re.DOTALL)]

calls = extract_tool_calls(output)
if calls:
    # WARNING: globals() — только для демо. В проде — словарь допустимых функций.
    results = [
        {"name": c['name'], "response": globals()[c['name']](**c['arguments'])}
        for c in calls
    ]

    message.append({
        "role": "assistant",
        "tool_calls": [{"function": call} for call in calls],
        "tool_responses": results
    })
```

### 3. Final Response — ответ модели с данными инструмента

```python
text = processor.apply_chat_template(message, tools=tools, tokenize=False, add_generation_prompt=True)
inputs = processor(text=text, return_tensors="pt").to(model.device)
out = model.generate(**inputs, max_new_tokens=128)
generated_tokens = out[0][len(inputs["input_ids"][0]):]
output = processor.decode(generated_tokens, skip_special_tokens=True)
# Output: "The current weather in Tokyo is 15 degrees Celsius and sunny."
```

---

## Function Calling с Thinking

Включить reasoning перед вызовом инструмента — модель лучше решает когда и с какими аргументами вызывать:

```python
text = processor.apply_chat_template(
    message, tools=tools, tokenize=False,
    add_generation_prompt=True,
    enable_thinking=True  # <-- включить
)
inputs = processor(text=text, return_tensors="pt").to(model.device)
out = model.generate(**inputs, max_new_tokens=1024)
output = processor.decode(out[0][input_len:], skip_special_tokens=False)

result = processor.parse_response(output)
# result содержит: role, thinking, content, tool_calls
```

---

## Формат истории (tool_responses)

```python
# Один вызов
"tool_responses": [
    {"name": "get_current_weather", "response": {"temperature": 15, "weather": "sunny"}}
]

# Несколько независимых вызовов
"tool_responses": [
    {"name": "func_1", "response": result_1},
    {"name": "func_2", "response": result_2},
]
```

---

## Отличие от Anthropic tool use

| | Gemma 4 | Anthropic Claude |
|---|---|---|
| Выполнение кода | На стороне разработчика | Опционально на серверах Anthropic |
| Парсинг вызовов | Вручную (regex) | Структурированный JSON |
| Thinking | `enable_thinking=True` | Extended thinking в API |
| Автосхема | `get_json_schema(fn)` | Только JSON schema вручную |
