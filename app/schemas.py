from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator

# Pure fat is about 900 kcal/100 g, so nothing real exceeds that.
KCAL_MAX = 900


class FoodIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    kcal_per_100g: float = Field(gt=0, le=KCAL_MAX)
    density_g_per_ml: float = Field(ge=0.1, le=2.0)


class FoodUpdate(BaseModel):
    """Values are required. The name is optional so the UI can update numbers only."""
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    kcal_per_100g: float = Field(gt=0, le=KCAL_MAX)
    density_g_per_ml: float = Field(ge=0.1, le=2.0)


class FoodOut(FoodIn):
    id: str
    source: str


Shape = Literal["cylinder", "tapered", "plate"]


class ContainerIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    shape: Shape
    capacity_ml: Optional[float] = Field(default=None, gt=0, le=20000)
    top_diam_cm: Optional[float] = Field(default=None, gt=0, le=100)
    base_diam_cm: Optional[float] = Field(default=None, gt=0, le=100)
    height_cm: Optional[float] = Field(default=None, gt=0, le=100)
    diameter_cm: Optional[float] = Field(default=None, gt=0, le=100)

    @model_validator(mode="after")
    def check_shape_fields(self):
        if self.shape == "cylinder":
            if self.capacity_ml is None or self.capacity_ml < 50:
                raise ValueError("cylinder needs capacity_ml of at least 50")
            self.top_diam_cm = self.base_diam_cm = self.height_cm = self.diameter_cm = None
        elif self.shape == "tapered":
            if None in (self.top_diam_cm, self.base_diam_cm, self.height_cm):
                raise ValueError("tapered needs top_diam_cm, base_diam_cm and height_cm")
            self.capacity_ml = self.diameter_cm = None
        else:  # plate
            if self.diameter_cm is None or self.diameter_cm < 5:
                raise ValueError("plate needs diameter_cm of at least 5")
            self.capacity_ml = self.top_diam_cm = self.base_diam_cm = self.height_cm = None
        return self


class ContainerOut(ContainerIn):
    id: str
