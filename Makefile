.PHONY: backend frontend test run docker

backend:
	python3 -m pip install -r backend/requirements.txt

frontend:
	npm run check:frontend

test:
	python3 -m unittest discover -s tests
	npm run check:frontend

run:
	cd backend && uvicorn app:app --host $${ALTEN_EMS_HOST:-0.0.0.0} --port $${ALTEN_EMS_PORT:-8000}

docker:
	docker compose up --build
