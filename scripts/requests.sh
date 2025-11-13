# POST com curl (Bash / WSL / Git Bash)
curl -X POST http://localhost:3001/api/update-predictions -H "Content-Type: application/json" -d '{"inputs":[[0.1,0.2,0.3],[0.2,0.3,0.4],[0.3,0.4,0.5]],"outputs":[0.5,0.6,0.7]}'

# GET com curl
curl -X GET http://localhost:3001/api/predictions
