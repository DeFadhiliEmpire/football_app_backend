require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");

const { router: authRouter } = require("./auth");
const { router: teamRouter } = require("./TeamApplication");
const { router: applicationRouter } = require("./playerApplcation");
const { router: managementRouter } = require("./teamManagement");

const app = express();
app.use(express.json());

//Routes
app.use(authRouter);
app.use(teamRouter);
app.use(applicationRouter);
app.use(managementRouter);

// DB + serve
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .then(() => {
    app.listen(process.env.PORT || 5000, () =>
      console.log(`Server running on port ${process.env.PORT || 3000}`)
    );
  })
  .catch(console.error);
