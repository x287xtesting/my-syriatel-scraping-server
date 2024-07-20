const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { JSDOM } = require("jsdom");
const fs = require("fs/promises");
const { HEADERS } = require("./headers");
const { PAYLOAD_TEMPLATE } = require("./payload-template");
const { randomUUID } = require("crypto");

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const users = new Map();

app.post("/", async (req, res) => {
	if (!req.body) {
		console.log(res.body);
		res.send(400);
	} else {
		try {
			// Get the phpssid token and captcha to log in
			const { captcha, token, phpssid } = await fetchCaptchaAndToken();
			const { username, password } = req.body;

			console.log(token, captcha, username, password);

			const loginRes = await login(
				username,
				password,
				captcha,
				token,
				phpssid
			);

			if (loginRes.ok) {
				const loginResText = await loginRes.text();
				console.log(loginResText);

				// login errors {message: "message"}
				if (loginResText.includes("danger")) {
					return res.status(400).json({
						message: new JSDOM(
							loginResText
						).window.document.querySelector("div").textContent,
					});
				} else {
					const loginCookies = getLoginCookies(loginRes);

					// Another request to fetch the gsmNo
					const gsmNo = await fetchGsmNo(loginCookies);

					if (gsmNo) {
						const userId = randomUUID();
						users.set(userId, { loginCookies, gsmNo });
						console.log(users);

						return res.status(200).json({ userId });
					} else {
						throw new Error("Server returned an empty gsm");
					}
				}
			}
			res.sendStatus(loginRes.status);
		} catch (error) {
			console.error(error);
			if (error.cause && error.cause.name === "ConnectTimeoutError")
				return res.status(500).json({
					message: "عطل في الشبكة، اعد المحاولة لاحقا، وبدون vpn",
				});

			return res.status(500).json({
				message: "حصل خطأ ما، العطل من السيرفر أعد المحاولة لاحقا",
			});
		}
	}
});

app.post("/bills", async (req, res, next) => {
	if (!req.body) {
		return res.status(400).json({ message: "Empty request body" });
	} else {
		const userId = req.header("userId");
		console.log(userId);
		console.log(users);

		if (!userId || !users.has(userId)) {
			console.log("user not found");
			return res.sendStatus(401);
		}
		const { gsmNo, loginCookies } = users.get(userId);
		console.log(gsmNo, loginCookies);

		const { billingAndSubscriptionNumbers, city } = req.body;
		console.log(billingAndSubscriptionNumbers);
		console.log(city);

		const batchSize = 10;

		const batches = [];

		while (billingAndSubscriptionNumbers.length) {
			batches.push(billingAndSubscriptionNumbers.splice(0, batchSize));
		}

		console.log(batches);
		let bills = [];
		try {
			for (let i = 0; i < batches.length; i++) {
				const batch = batches[i];

				const promises = batch.map((pbObj) =>
					fetchBill(
						getPayload(getBillingNo(pbObj, city), gsmNo),
						loginCookies
					)
				);

				const responses = await Promise.all(promises);

				const responsesHTML = await Promise.all(
					responses.map((res) => {
						if (
							res.ok &&
							res.headers.get("Content-Type").includes("html")
						) {
							return res.text();
						} else {
							return "";
						}
					})
				);

				responsesHTML.forEach((resText, index) => {
					if (
						resText.includes(
							"عذراً الخدمة غير متاحة حالياً من جهة مزود الخدمة، الرجاء المحاولة لاحقاً"
						) ||
						resText.includes(
							"عذراً يوجد ضغط على الخدمة من طرف مزود الخدمة، الرجاء المحاولة لاحقاً"
						)
					) {
						const error = new Error(
							new JSDOM(resText).window.document.querySelector(
								"div"
							).textContent
						);
						error.name = "SyriatelError";
						throw error;
					}
					let bill;
					if (
						resText.includes(
							"عذراً، لم يتم تنفيذ طلبك لأسباب تقنية من طرف مزود الخدمة. الرجاء إعادة إرسال الطلب لاحقاً"
						)
					) {
						bill = {
							error: "حصل خطأ عند تحصيل هذه الفاتورة",
							id: "id" + Math.random().toString(16).slice(2),
							...batch[index],
						};
					} else {
						bill = getBill(resText, batch[index]);
					}
					console.log(bill);
					bills.push(bill);
				});
			}
			return res.json(bills);
		} catch (error) {
			console.error(error);
			if (error.cause && error.cause.name === "ConnectTimeoutError")
				return res.status(500).json({
					message: "عطل في الشبكة، اعد المحاولة لاحقا، وبدون vpn",
				});

			if (error.name === "SyriatelError") {
				return res.status(500).json({ message: error.message });
			}
			return res.status(500).json({
				message: "حصل خطأ ما، العطل من السيرفر أعد المحاولة لاحقا",
			});
		}
	}
});

app.listen(port, "0.0.0.0", () => {
	console.log(`Server listening on port ${port}`);
});

async function fetchCaptchaAndToken() {
	const syrRes = await fetch("https://my.syriatel.sy/index.php");
	const syrResText = await syrRes.text();

	fs.writeFile("response.html", syrResText);

	const phpssid = syrRes.headers.getSetCookie()[0];

	const dom = new JSDOM(syrResText);

	const token = dom.window.document.querySelector("#token").value;
	const captcha = dom.window.document.querySelector("#captchaId").value;

	return {
		phpssid,
		token,
		captcha,
	};
}

async function fetchGsmNo(loginCookies) {
	const sepRes = await fetch("https://my.syriatel.sy/sep.php", {
		headers: { Cookie: loginCookies },
	});

	if (sepRes.ok) {
		const sepText = await sepRes.text();
		const gsmNo = new JSDOM(sepText).window.document.querySelector(
			".selected-gsm"
		).value;
		return gsmNo;
	} else {
		return null;
	}
}

async function login(username, password, captcha, token, phpssid) {
	const fd = new FormData();
	fd.append("username", username);
	fd.append("password", password);
	fd.append("app", "1");
	fd.append("captcha", captcha);
	fd.append("token", token);
	const urlencoded = new URLSearchParams(fd);

	// log in
	const LOGIN_URL = "https://my.syriatel.sy/ws/checkLogin.php";

	return fetch(LOGIN_URL, {
		method: "POST",
		body: urlencoded,
		headers: {
			Cookie: phpssid,
		},
	});
}

function getLoginCookies(loginRes) {
	return loginRes.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0].trim())
		.join("; ");
}

function getBillingNo({ billingNo, subscriptionNo }, city) {
	return `${city}_${billingNo}_${subscriptionNo}`;
}

function getPayload(billingNo, gsmNo) {
	const payloadObj = {
		...PAYLOAD_TEMPLATE,
		gsmNo,
		values: [{ ...PAYLOAD_TEMPLATE.values[0], billingNo }],
	};

	const payloadString = JSON.stringify(payloadObj);

	const payloadEncoded = encodeURIComponent(payloadString);

	console.log(payloadString);
	return payloadEncoded;
}

function fetchBill(payload, loginCookies) {
	const headers = { ...HEADERS, Cookie: loginCookies };

	return fetch("https://my.syriatel.sy/ws/sep.php", {
		body: `myData=${payload}`,
		method: "POST",
		mode: "cors",
		headers,
	});
}

function getBill(htmlText, { billingNo, subscriptionNo }) {
	const dom = new JSDOM(htmlText)?.window.document;
	let amount, fee, fullName, name, year, period;

	if (dom) {
		const inputElem = dom.querySelector("input[data-amount]");
		const panelBody = dom.querySelector(".panel-body");

		if (inputElem) {
			fee = Number.parseInt(inputElem.getAttribute("data-fee"));
			amount = Number.parseInt(inputElem.getAttribute("data-amount"));
		}

		if (panelBody && panelBody.children) {
			const nameRow = panelBody.children.item(5);
			fullName = nameRow?.lastElementChild?.textContent.trim();
			name = fullName.split(",")[0].split(":")[1].trim();
			year = fullName.split(",")[1].split("عام")[1].trim();
			period = fullName
				.split(",")[1]
				.split("عام")[0]
				.split(":")[1]
				.trim();
		}
	}

	return {
		name,
		period,
		year,
		amount,
		fee,
		billingNo,
		subscriptionNo,
		id: "id" + Math.random().toString(16).slice(2),
	};
}
