# Gmail HR Mail Classifier v2

Скрипт для автоматической классификации писем во "Входящих" Gmail с помощью LLM (OpenRouter). Присваивает новые метки: `interview_v2`, `rejected_v2`, `received_v2`, `to_check_v2`. Результаты кэшируются и логируются в Google Sheets.

## Использование
1. Вставьте свой OpenRouter API-ключ в переменную `API_KEY` в main.js.
2. Запустите функцию `classifyHRMails()` в Google Apps Script.
3. Скрипт обработает все входящие письма и присвоит соответствующие метки.

## Требования
- Google Apps Script (Gmail, Spreadsheet, Cache сервисы)
- Ключ OpenRouter

## Куда вставлять скрипт
1. Откройте [Google Apps Script](https://script.google.com/) (или через Gmail: Расширения → Apps Script).
2. Создайте новый проект.
3. Скопируйте содержимое файла `main.js` в редактор Apps Script.
4. Сохраните проект и предоставьте необходимые разрешения при первом запуске.

## Автор
ChatGPT, 2025 