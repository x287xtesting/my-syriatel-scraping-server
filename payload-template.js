const PAYLOAD_TEMPLATE = {
	gsmNo: "",
	action: "billes",
	filter: "2",
	values: [
		{
			billingNo: "",
			dateFrom: "",
			dateTo: "",
			serviceType: "ElecBill",
			incPaidBills: "N",
		},
	],
	biller: "BL1024",
	service: "ElecBill",
};

module.exports = { PAYLOAD_TEMPLATE };
