# Ελλάδα • Κινηματογραφικές Κυκλοφορίες 12μήνου

Stremio catalog-only addon για κυλιόμενο τελευταίο 12μηνο ελληνικών κινηματογραφικών κυκλοφοριών.

Χρησιμοποιεί TMDB `region=GR`, theatrical release types 2/3 και δεύτερο αυστηρό έλεγχο των ελληνικών release dates ανά ταινία. Κρατά μόνο ταινίες με IMDb ID, ταξινομεί με τη νεότερη ελληνική κινηματογραφική ημερομηνία πρώτη και υποστηρίζει επίσημες επανεκδόσεις.

Απαιτεί environment variable `TMDB_TOKEN` (API Read Access Token). Δεν αποθηκεύεται στο repository.

Start: `npm start`

Manifest μετά το deployment: `https://<domain>/manifest.json`
